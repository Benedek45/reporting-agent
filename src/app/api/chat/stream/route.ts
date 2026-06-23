export const runtime = "nodejs";

import { NextRequest } from "next/server";
import {
  openEventStream,
  promptAsync,
  getLatestContextTokens,
  contextUsedTokens,
  computeContextBreakdown,
  getProviderContextLimit,
  revertSession,
} from "@/lib/opencode";
import {
  incrementMessageCount,
  sessionDirectory,
  readSessionState,
  readRoadmapState,
  renderRoadmapForContext,
  readUploadMarkdown,
  addLoadedContextBytes,
  recordReadDocBytes,
  sumReadDocBytes,
  bumpTimeIfDue,
  getAgentsText,
  getGoalText,
} from "@/lib/workspace";
import type { StreamEvent, TodoItem } from "@/types";

/**
 * Always-on guidance appended to the first turn's system context. Kept here
 * (injected dynamically) rather than in the prompt/skill files so those stay
 * unchanged. Covers the merged workspace folder, deliverable presentation, and
 * roadmap upkeep.
 */
/**
 * Workspace guidance for the MAIN compliance agent.
 * Roadmap tool instructions are intentionally omitted here — a dedicated
 * roadmap-sync sub-agent runs automatically after every turn and owns all
 * roadmap_mark_done / roadmap_mark_undone calls.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function workspaceGuidance(_directory: string): string {
  return (
    "## Workspace & deliverables\n" +
    "- The documents the user uploads AND the report you write live in the `output/` " +
    "folder. Write the report to `output/report.md`.\n" +
    "- `report.md` is shown to the user automatically. If you produce any OTHER " +
    "deliverable file, call the `present_file` tool with its absolute path so the " +
    "user sees it under 'Presented'.\n" +
    "- The progress bar below is updated automatically after each turn — you do NOT " +
    "need to call any roadmap tool yourself."
  );
}

/**
 * Workspace + roadmap guidance for the ROADMAP-SYNC sub-agent only.
 * This is the single place where roadmap_mark_done / roadmap_mark_undone are mentioned.
 */
function roadmapSyncGuidance(directory: string): string {
  return (
    "## Roadmap sync task\n" +
    "Your ONLY job is to call `roadmap_mark_done` and/or `roadmap_mark_undone` based " +
    "on the conversation history above.\n\n" +
    "Rules:\n" +
    "1. Call `roadmap_mark_done` with `workspace_dir` = `" +
    directory +
    "` and `items` = short descriptions of EVERY checklist item where data was " +
    "OBTAINED in the latest exchange (user confirmed it, or it appears in an " +
    "uploaded document). Fuzzy-matching is used — use natural descriptions.\n" +
    "2. Call `roadmap_mark_undone` with the same `workspace_dir` for any item that " +
    "was previously marked done but is now known to be wrong (contradiction found, " +
    "source replaced, or user corrected/retracted it).\n" +
    "3. Do NOT write to the report, do NOT ask questions, do NOT produce any visible " +
    "reply beyond <reply>Synced.</reply>."
  );
}

const VISIBLE_REPLY_GUARD =
  "## Output format — wrap your visible reply in <reply>...</reply>\n" +
  "Do any internal planning, file-reading notes, tool reasoning, or self-instructions FIRST " +
  "(or keep them in your reasoning channel). Then write the message the user should see, wrapped " +
  "in <reply> and </reply> tags. ONLY the text inside <reply>...</reply> is shown to the user; " +
  "everything outside the tags is discarded. Always include BOTH tags, even for a one-line reply.\n" +
  "Example:\n" +
  "I've read the uploaded file; it has supplier data. I still need the entity name and fiscal year.\n" +
  "<reply>\n" +
  "Thanks — I've reviewed your supplier data file. To frame the report correctly, could you tell me " +
  "the legal name of the reporting entity and the fiscal year you're covering?\n" +
  "</reply>\n" +
  "Never put planning such as `The skill is loaded`, `Now I need to`, `I will combine`, " +
  "`The user uploaded`, `There is no .md version`, or a `Plan:` section INSIDE the <reply> tags — " +
  "keep all of that before the opening <reply> tag.";

// Idle timeout: max time with ZERO upstream activity before we give up.
// This is reset on every chunk received from the engine's /event stream.
// Because a subagent (fact-checker) `task` runs in a child session whose
// events still flow through the same directory event stream, this timer keeps
// resetting while the subagent works — so long fact-checks (minutes) no longer
// get cut off. It only fires after genuine silence.
const IDLE_TIMEOUT_MS = 300_000; // 5 minutes of complete silence
const MAX_CONTEXT_FILE_BYTES = Number(
  process.env.MAX_CONTEXT_FILE_BYTES || 200_000
);

/**
 * Parses a raw SSE text block (between double-newlines) into its data payload.
 * Returns the parsed JSON object if the block contains a `data:` line, else null.
 */
function parseSseBlock(block: string): Record<string, unknown> | null {
  for (const line of block.split("\n")) {
    const trimmed = line.trimEnd();
    if (trimmed.startsWith("data:")) {
      const json = trimmed.slice(5).trim();
      if (!json) return null;
      try {
        return JSON.parse(json) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function sseFrame(event: StreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * POST /api/chat/stream
 * Body: { sessionId: string, text?: string, editMessageId?: string, loadFileName?: string }
 * Returns: text/event-stream
 *
 * Downstream SSE protocol:
 *   { type: "text",      delta: string }
 *   { type: "reasoning", delta: string }
 *   { type: "tool",      id, name, status, title?, input?, output?, error? }
 *   { type: "todos",     todos: TodoItem[] }
 *   { type: "status",    status: string }
 *   { type: "usage",     usedTokens, contextLimit, pct, breakdown: ContextBreakdownItem[] }
 *   { type: "done" }
 *   { type: "error",     error: string }
 */
interface NotifyPayload {
  kind: "upload" | "replace" | "edit";
  files: { name: string; diff?: string; markdownName?: string }[];
}

/**
 * Builds the prompt text for an out-of-band workspace notification (file
 * upload / replacement / in-app edit). This is fired as its OWN agent turn
 * (not bound to a user prompt), so the agent reacts immediately.
 */
function diffBlock(f: { name: string; diff?: string }): string {
  return `### ${f.name}\n\`\`\`diff\n${f.diff ?? "(no diff available)"}\n\`\`\``;
}

function buildNotifyText(n: NotifyPayload): string {
  const prefix = "[Workspace update — not a user message] ";
  const tail =
    "\n\nThen do these steps IN ORDER:\n" +
    "1. Fold the data into `output/report.md` (create it from the template if it " +
    "does not exist yet, using `[DATA NEEDED: …]` for anything still missing).\n" +
    "2. Give the user a one-line summary of what you found and what you still need.";

  if (n.kind === "upload") {
    const fresh = n.files.filter((f) => !f.diff);
    const changed = n.files.filter((f) => f.diff);
    let msg = prefix;
    if (fresh.length > 0) {
      const fileDescs = fresh.map((f) =>
        f.markdownName
          ? `${f.name} (auto-converted → read as ${f.markdownName})`
          : f.name
      );
      msg +=
        `The user added ${fresh.length} new document(s): ${fileDescs.join(", ")}. ` +
        `Read the .md version for any converted files. `;
    }
    if (changed.length > 0) {
      msg +=
        `The user also replaced: ${changed.map((f) => f.name).join(", ")}.\n\n` +
        changed.map(diffBlock).join("\n\n");
    }
    return msg + tail;
  }

  const verb = n.kind === "edit" ? "edited" : "replaced";
  return (
    prefix +
    `The user ${verb} the following file(s). Review the changes below, update ` +
    `the report if it is affected, and briefly confirm what changed.\n\n` +
    n.files.map(diffBlock).join("\n\n") +
    tail
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  let sessionId: string;
  let userText: string | undefined;
  let editMessageId: string | undefined;
  let loadFileName: string | undefined;
  let notify: NotifyPayload | undefined;

  try {
    const body = (await req.json()) as {
      sessionId?: string;
      text?: string;
      editMessageId?: string;
      loadFileName?: string;
      notify?: NotifyPayload;
    };
    if (!body.sessionId || typeof body.sessionId !== "string") {
      return Response.json({ error: "sessionId is required" }, { status: 400 });
    }
    sessionId = body.sessionId;
    userText = body.text;
    editMessageId = body.editMessageId;
    loadFileName = body.loadFileName;
    notify =
      body.notify && Array.isArray(body.notify.files) && body.notify.files.length > 0
        ? body.notify
        : undefined;

    // Must have text, a file to load, or a notification
    if (!userText && !loadFileName && !notify) {
      return Response.json(
        { error: "text, loadFileName, or notify is required" },
        { status: 400 }
      );
    }
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Handle loadFileName size check before opening the stream
  let loadedMarkdown: string | undefined;
  let loadedBytes = 0;
  if (loadFileName) {
    try {
      const { markdown, bytes } = await readUploadMarkdown(sessionId, loadFileName);
      if (bytes > MAX_CONTEXT_FILE_BYTES) {
        return Response.json(
          { error: "file too large to load fully", bytes, max: MAX_CONTEXT_FILE_BYTES },
          { status: 413 }
        );
      }
      loadedMarkdown = markdown;
      loadedBytes = bytes;
    } catch (err) {
      return Response.json(
        { error: `Could not read file: ${err instanceof Error ? err.message : String(err)}` },
        { status: 404 }
      );
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();

      function emit(event: StreamEvent): void {
        controller.enqueue(encoder.encode(sseFrame(event)));
      }

      function close(): void {
        try {
          controller.close();
        } catch {
          // Already closed
        }
      }

      let upstreamRes: Response | null = null;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

      try {
        // Step 1: resolve directory
        const directory = await sessionDirectory(sessionId);

        // Step 2: if editing, revert to the target message first
        if (editMessageId) {
          await revertSession(sessionId, editMessageId, directory);
        }

        // Step 3: read state BEFORE incrementing so we can compute isFirstTurn
        // from the pre-increment count. incrementMessageCount is called AFTER
        // promptAsync succeeds to avoid a stale count if the prompt fails.
        const preState = await readSessionState(sessionId);
        const isFirstTurn = preState.messageCount === 0;

        // Step 4: build system string (uses pre-increment state for goal/agents)

        const systemParts: string[] = [];

        const timeStr = await bumpTimeIfDue(sessionId);
        if (timeStr) systemParts.push(timeStr);

        if (isFirstTurn) {
          const goalText = await getGoalText(sessionId);
          if (goalText) systemParts.push(goalText);

          const agentsText = await getAgentsText(sessionId);
          if (agentsText) {
            systemParts.push(
              `## Your long-term memory (AGENTS.md)\n\n` +
                `This file is your persistent memory for this engagement. It survives context ` +
                `compaction — anything you should remember long-term belongs here. Read it at ` +
                `the start of each turn and keep it up to date with the user's preferences, ` +
                `decisions, and standing instructions.\n\n${agentsText}`
            );
          }
        } else {
          // Periodic goal re-anchoring: every 5th user turn (post-increment
          // count), inject a compact reminder of the active goal. This counters
          // instruction fade after many tool calls — the model's attention to
          // the original goal degrades over long conversations.
          // We use the pre-increment count here; the actual post-increment count
          // will be preState.messageCount + 1, so anchor when that equals 0 mod 5
          // (i.e. preState.messageCount % 5 === 4).
          const postIncrementCount = preState.messageCount + 1;
          if (postIncrementCount % 5 === 0) {
            const goalText = await getGoalText(sessionId);
            if (goalText) {
              const excerpt = goalText.slice(0, 600);
              systemParts.push(
                `REMINDER — Active goal: ${excerpt}${goalText.length > 600 ? "…" : ""}. ` +
                  `Report status: keep all figures attributed to sources; ` +
                  `use [DATA NEEDED: …] for anything missing; never fabricate.`
              );
            }
          }
        }

        // Workspace, deliverables & roadmap guidance — always injected so it
        // survives compaction (re-injected each turn on top of compacted history).
        // The exact workspace_dir is baked in so the roadmap tool gets the right path.
        systemParts.push(workspaceGuidance(directory));

        // The roadmap checklist itself — injected EVERY turn so the full plan is
        // in context from the first turn and the current done/open state stays
        // visible. This is what makes the agent keep the roadmap updated without
        // having to call roadmap_status to discover what is left.
        const roadmapContext = await renderRoadmapForContext(sessionId);
        if (roadmapContext) systemParts.push(roadmapContext);

        systemParts.push(
          "Reply in the same language the user writes in unless they ask otherwise."
        );

        // If loading a file, append its content to the system string
        if (loadFileName && loadedMarkdown !== undefined) {
          systemParts.push(
            `## Document loaded into context: "${loadFileName}"\n\n${loadedMarkdown}`
          );
          await addLoadedContextBytes(sessionId, loadedBytes);
        }

        // Last-position guard for Gemma-style models that may put planning into
        // the final answer instead of the provider's reasoning field.
        systemParts.push(VISIBLE_REPLY_GUARD);

        const system = systemParts.filter(Boolean).join("\n\n");

        // Determine the prompt text for this turn
        const text = userText
          ? userText
          : loadFileName
            ? `Please review the document "${loadFileName}" I've loaded into context.`
            : notify
              ? buildNotifyText(notify)
              : "";

        // Step 5: open upstream SSE BEFORE prompting to avoid missing early events
        upstreamRes = await openEventStream(directory);

        // Step 6: fire the async prompt, then increment the message count.
        // Incrementing AFTER a successful prompt ensures the count stays in sync
        // with the engine — a failed prompt does not advance the counter, and the
        // edit/revert path does not double-count.
        await promptAsync(sessionId, text, { directory, system });
        await incrementMessageCount(sessionId);

        // Step 7: parse upstream SSE and relay filtered events
        const body = upstreamRes.body;
        if (!body) {
          throw new Error("Upstream /event response has no body");
        }

        let sawBusy = false;
        let done = false;
        // Phase tracking for the sequential roadmap-sync sub-agent.
        // After the main agent goes idle, we fire the sub-agent on the SAME session
        // and event stream — the stream stays open until the sub-agent also goes idle.
        // This prevents race conditions that arose when the sub-agent was fired as a
        // background fire-and-forget after close().
        let subagentFired = false;
        // During the sub-agent phase we suppress text/reasoning deltas so the user
        // only sees the roadmap bar update, not the "<reply>Synced.</reply>" text.
        let inSubagentPhase = false;
        // partIDs whose deltas are the model's internal reasoning (not the answer)
        const reasoningParts = new Set<string>();
        // tool-call part ids whose `read` output we've already counted toward
        // the Documents context bucket (avoids redundant state writes)
        const recordedReads = new Set<string>();

        // Activity-based idle timeout. Re-armed on every upstream chunk
        // (see the read loop below). Only fires after IDLE_TIMEOUT_MS of
        // complete silence, so long subagent (fact-checker) runs — which keep
        // the directory event stream busy — are not cut off.
        const armIdleTimeout = (): void => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          timeoutHandle = setTimeout(() => {
            if (!done) {
              done = true;
              emit({ type: "done" });
              close();
            }
          }, IDLE_TIMEOUT_MS);
        };
        armIdleTimeout();

        const doFinish = async (): Promise<void> => {
          if (done) return;
          done = true;
          try {
            const [tokensDetail, contextLimit] = await Promise.all([
              getLatestContextTokens(sessionId, directory),
              getProviderContextLimit(),
            ]);

            // True current context-window occupancy from the latest turn
            // (NOT the engine's cumulative lifetime sum).
            const usedTokens = contextUsedTokens(tokensDetail);

            const pct = Math.min(
              100,
              Math.round((usedTokens / contextLimit) * 100)
            );

            // Build breakdown (approximate — labeled as such). Clamped to the
            // real total so a stale cumulative Documents counter can't exceed
            // usedTokens after the context-manager compresses (see helper doc).
            const reasoningTokens = tokensDetail.reasoning ?? 0;

            // Re-read state to get latest document byte counters
            const latestState = await readSessionState(sessionId).catch(
              () => preState
            );
            // Documents = files loaded via the button + files the agent read
            const documentBytes =
              (latestState.loadedContextBytes ?? 0) +
              sumReadDocBytes(latestState);

            const breakdown = computeContextBreakdown(
              usedTokens,
              reasoningTokens,
              documentBytes
            );

            emit({ type: "usage", usedTokens, contextLimit, pct, breakdown });
          } catch {
            // Non-fatal — skip usage frame
          }
          // Roadmap progress (parsed from roadmap.md) — non-fatal.
          try {
            const roadmap = await readRoadmapState(sessionId);
            if (roadmap) emit({ type: "roadmap", roadmap });
          } catch {
            // No roadmap / parse error — skip
          }
          emit({ type: "done" });
          if (timeoutHandle) clearTimeout(timeoutHandle);
          close();
        };

        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        try {
        while (!done) {
          const { value, done: streamDone } = await reader.read();
          if (streamDone) break;

          // Any upstream activity (including filtered-out subagent events
          // from the same directory) proves the turn is still alive — re-arm
          // the idle timer so long fact-checks don't get cut off.
          armIdleTimeout();

          buffer += decoder.decode(value, { stream: true });

          // SSE frames are separated by double newlines
          const blocks = buffer.split("\n\n");
          // Keep the last (potentially incomplete) block in the buffer
          buffer = blocks.pop() ?? "";

          for (const block of blocks) {
            if (!block.trim()) continue;

            const parsed = parseSseBlock(block);
            if (!parsed) continue;

            const type = parsed["type"] as string | undefined;
            const props = parsed["properties"] as
              | Record<string, unknown>
              | undefined;

            if (!props) continue;

            // Filter to our session only
            const frameSid = props["sessionID"] as string | undefined;
            if (frameSid !== sessionId) continue;

            if (type === "message.part.delta") {
              const field = props["field"] as string | undefined;
              const delta = props["delta"] as string | undefined;
              const partID = props["partID"] as string | undefined;
              // Suppress text/reasoning deltas during the sub-agent phase —
              // the user sees the roadmap bar update but not "Synced." text.
              if (!inSubagentPhase && typeof delta === "string") {
                const isReasoning =
                  field === "reasoning" ||
                  (partID !== undefined && reasoningParts.has(partID));
                if (isReasoning) {
                  emit({ type: "reasoning", delta });
                } else if (field === "text") {
                  emit({ type: "text", delta });
                }
              }
            } else if (type === "message.part.updated") {
              // Register reasoning parts so their deltas are kept out of the answer.
              const part = props["part"] as
                | {
                    type?: string;
                    id?: string;
                    tool?: string;
                    callID?: string;
                    state?: {
                      status?: string;
                      input?: unknown;
                      output?: string;
                      error?: string;
                      title?: string;
                    };
                  }
                | undefined;

              if (part?.type === "reasoning" && typeof part.id === "string") {
                reasoningParts.add(part.id);
              } else if (
                part?.type === "tool" &&
                typeof part.id === "string" &&
                typeof part.tool === "string"
              ) {
                // Emit tool events only for the main agent. Roadmap-sync tools are
                // intentionally hidden; the user sees only the progress bar update.
                if (!inSubagentPhase) {
                  emit({
                    type: "tool",
                    id: part.id,
                    name: part.tool,
                    status:
                      (part.state?.status as
                        | "pending"
                        | "running"
                        | "completed"
                        | "error") ?? "pending",
                    title: part.state?.title,
                    input: part.state?.input,
                    output: part.state?.output,
                    error: part.state?.error,
                  });
                }

                // Emit live roadmap frame whenever mark_done / mark_undone
                // completes — gives the UI real-time progress without waiting
                // for doFinish at the end of the turn.
                if (
                  (part.tool === "roadmap_mark_done" ||
                    part.tool === "roadmap_mark_undone") &&
                  part.state?.status === "completed"
                ) {
                  void readRoadmapState(sessionId)
                    .then((rm) => {
                      if (rm) emit({ type: "roadmap", roadmap: rm });
                    })
                    .catch(() => {});
                }

                // Attribute file content the agent reads to the Documents
                // bucket of the context breakdown (not Conversation).
                if (
                  part.tool === "read" &&
                  part.state?.status === "completed" &&
                  typeof part.state.output === "string" &&
                  !recordedReads.has(part.id)
                ) {
                  recordedReads.add(part.id);
                  const inp = part.state.input as
                    | { filePath?: string; path?: string; file?: string }
                    | undefined;
                  const pathKey =
                    inp?.filePath ?? inp?.path ?? inp?.file ?? part.id;
                  const bytes = part.state.output.length;
                  void recordReadDocBytes(sessionId, pathKey, bytes).catch(
                    (e) => console.debug("[stream] recordReadDocBytes failed:", e)
                  );
                }
              }
            } else if (type === "todo.updated") {
              const todos = props["todos"] as TodoItem[] | undefined;
              if (Array.isArray(todos)) {
                emit({ type: "todos", todos });
              }
            } else if (type === "session.status") {
              const statusObj = props["status"] as
                | { type?: string }
                | undefined;
              const statusType = statusObj?.type ?? "idle";
              // Only emit status frames for the main agent turn, not the sub-agent —
              // otherwise the UI would flash a spurious "idle" between turns.
              if (!inSubagentPhase) {
                emit({ type: "status", status: statusType });
              }

              if (statusType === "busy") {
                sawBusy = true;
              } else if (statusType === "idle" && sawBusy) {
                if (!subagentFired) {
                  // Phase transition: main turn done → fire roadmap-sync sub-agent.
                  // Keep the stream open — the sub-agent runs synchronously here.
                  subagentFired = true;
                  inSubagentPhase = true;
                  sawBusy = false; // reset for the sub-agent busy→idle cycle
                  try {
                    const roadmapCtx = await renderRoadmapForContext(sessionId);
                    const syncSystem = [
                      roadmapSyncGuidance(directory),
                      roadmapCtx,
                      VISIBLE_REPLY_GUARD,
                    ]
                      .filter(Boolean)
                      .join("\n\n");
                    await promptAsync(
                      sessionId,
                      "[Roadmap sync — automated] Sync.",
                      { agent: "roadmap-sync", directory, system: syncSystem }
                    );
                    // Sub-agent turn is now running — continue the event loop.
                  } catch {
                    // Sub-agent failed to start — fall through to doFinish.
                    await doFinish();
                    break;
                  }
                } else {
                  // Sub-agent turn (or notify/no-text turn) completed — finish.
                  await doFinish();
                  break;
                }
              }
            } else if (type === "session.idle") {
              // Terminal event emitted once when the agent finishes its turn.
              // After we fire the roadmap-sync sub-agent, the engine can still
              // deliver the main turn's trailing session.idle. Ignore it until
              // the sub-agent has produced its own busy→idle cycle.
              if (inSubagentPhase && !sawBusy) {
                continue;
              }
              if (!inSubagentPhase) {
                emit({ type: "status", status: "idle" });
              }
              if (!subagentFired) {
                subagentFired = true;
                inSubagentPhase = true;
                sawBusy = false;
                try {
                  const roadmapCtx = await renderRoadmapForContext(sessionId);
                  const syncSystem = [
                    roadmapSyncGuidance(directory),
                    roadmapCtx,
                    VISIBLE_REPLY_GUARD,
                  ]
                    .filter(Boolean)
                    .join("\n\n");
                  await promptAsync(
                    sessionId,
                    "[Roadmap sync — automated] Sync.",
                    { agent: "roadmap-sync", directory, system: syncSystem }
                  );
                } catch {
                  await doFinish();
                  break;
                }
              } else {
                await doFinish();
                break;
              }
            }
          }
        }

        // Stream ended without seeing idle — close gracefully
        if (!done) {
          done = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          emit({ type: "done" });
          close();
        }
        } finally {
          // Always release the upstream reader to avoid resource leaks.
          reader.cancel().catch(() => {});
        }
      } catch (err) {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        upstreamRes?.body?.cancel().catch(() => {});
        const message = err instanceof Error ? err.message : "Internal error";
        try {
          emit({ type: "error", error: message });
        } catch {
          // Controller may already be closed
        }
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
