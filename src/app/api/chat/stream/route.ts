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
function workspaceGuidance(directory: string): string {
  return (
    "## Workspace, deliverables & roadmap\n" +
    "- The documents the user uploads AND the report you write live in the `output/` " +
    "folder. Write the report to `output/report.md`.\n" +
    "- `report.md` is shown to the user automatically. If you produce any OTHER " +
    "deliverable file, call the `present_file` tool with its absolute path so the " +
    "user sees it under 'Presented'.\n" +
    "- To record progress, call the `roadmap_mark_done` tool. Pass `workspace_dir` = `" +
    directory +
    "` and `items` = short descriptions of checklist items whose data you just " +
    "OBTAINED. Mark items the SAME turn you get the data. Fuzzy-matching is used.\n" +
    "- To re-open a wrong item, call `roadmap_mark_undone` with the same workspace_dir.\n" +
    "- Do NOT edit `roadmap.md` yourself — the tools are the only correct way."
  );
}

const VISIBLE_REPLY_GUARD =
  "## Output format\n" +
  "Wrap your visible reply in <reply>...</reply>. Put your answer between the tags.\n" +
  "<reply>\n" +
  "Thanks for the details. Entity name and fiscal year noted.\n" +
  "</reply>\n" +
  "Never put planning inside <reply> tags.";

// Idle timeout: max time with ZERO upstream activity before we give up.
// This is reset on every chunk received from the engine's /event stream.
// Because a subagent (fact-checker) `task` runs in a child session whose
// events still flow through the same directory event stream, this timer keeps
// resetting while the subagent works — so long fact-checks (minutes) no longer
// get cut off. It only fires after genuine silence.
const IDLE_TIMEOUT_MS = 300_000; // 5 minutes of complete silence
// Local models (Qwen3.6:27b / Gemma via Ollama) intermittently produce a
// DEGENERATE EMPTY TURN — they go busy, (optionally) emit reasoning, then go
// idle with no answer text and no tool calls. When that happens we re-fire the
// same prompt up to this many times before giving up. deepseek-v4-flash rarely
// needs it; this makes the local-model path robust.
const MAX_EMPTY_RETRIES = 2;
// After the main turn finishes, a hidden "roadmap sync" turn is auto-fired to
// the same agent (like an upload-notify turn) to mark progress. If that sync
// turn degenerates (never goes busy — a local-model empty turn), this watchdog
// force-finishes the stream so it can't hang.
const SUBAGENT_WATCHDOG_MS = 20_000;
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
    "2. ALWAYS reply to the user in their language: briefly confirm what you " +
    "recorded, then CONTINUE the interview by asking for the next documents or " +
    "information you still need (pick the most important still-missing items). " +
    "Never end your turn silently — the user is waiting for your next question.";

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
        // Empty-turn detection + retry (local-model robustness). A turn "produced
        // content" if we saw a TEXT delta or a TOOL call during it (reasoning-only
        // counts as empty). Reset before each (re)fire.
        let producedContent = false;
        // Visible-answer-text detection (separate from producedContent). A turn can
        // do tool work (read/write) but emit ZERO visible text — a known intermittent
        // local-model behaviour. When that happens on a user-facing turn we fire a
        // CONTINUATION turn so the agent confirms + asks for the next documents/info,
        // instead of leaving the user with no question to answer.
        let sawText = false;
        let continuationFired = false;
        let inContinuationPhase = false;
        let continuationText = "";
        let continuationSystem = "";
        let retries = 0;
        // Hidden roadmap-sync turn (fired after the main turn, like a notify turn).
        // subagentFired: the sync prompt has been sent. inSubagentPhase: we are now
        // relaying the sync turn (its text/tools/status are suppressed). subagentBusy:
        // the sync turn actually started running (so we wait for its real idle rather
        // than the main turn's trailing idle). subagentWatchdog force-finishes if the
        // sync turn never goes busy (degenerate empty turn). It is armed on EVERY
        // promptAsync for a follow-on turn and only cleared by doFinish() — never
        // cleared on a busy edge so a busy-then-error path still terminates.
        let subagentFired = false;
        let inSubagentPhase = false;
        let subagentBusy = false;
        let subagentWatchdog: ReturnType<typeof setTimeout> | null = null;
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
          if (subagentWatchdog) clearTimeout(subagentWatchdog);
          close();
        };

        // Fire the hidden roadmap-sync turn. Same agent, same model, same session
        // — exactly like an upload-notify turn, just auto-triggered and hidden.
        // The agent is asked to call roadmap_mark_done for items that now have data.
        const fireRoadmapSync = async (): Promise<boolean> => {
          try {
            const roadmapCtx = await renderRoadmapForContext(sessionId);
            const syncSystem = [workspaceGuidance(directory), roadmapCtx]
              .filter(Boolean)
              .join("\n\n");
            const syncText =
              "[Roadmap sync — automated] Review the conversation above. " +
              "Call roadmap_mark_done for EVERY checklist item that now has data " +
              "(a confirmed answer from the user or an uploaded document). " +
              "Call roadmap_mark_undone for any item now contradicted. " +
              "Then reply exactly <reply>Synced.</reply>.";
            await promptAsync(sessionId, syncText, {
              directory,
              system: syncSystem,
            });
            // Guaranteed backstop: arm the watchdog AFTER every follow-on promptAsync.
            // It is only cleared by doFinish() — never on a busy edge — so a
            // busy-then-session.error path (engine errors without emitting idle) still
            // terminates within SUBAGENT_WATCHDOG_MS.
            if (subagentWatchdog) clearTimeout(subagentWatchdog);
            subagentWatchdog = setTimeout(() => void doFinish(), SUBAGENT_WATCHDOG_MS);
            return true;
          } catch {
            return false;
          }
        };

        // Fire a VISIBLE continuation turn. Used when a user-facing turn did tool
        // work (read/write) but produced no visible text — the agent must keep the
        // interview moving by confirming what it recorded and asking for the next
        // documents/information. Same agent/model/session; its reply IS shown (only
        // its auto-generated user prompt is hidden in the UI history).
        const fireContinuation = async (): Promise<boolean> => {
          try {
            const goalText = await getGoalText(sessionId).catch(() => "");
            const roadmapCtx = await renderRoadmapForContext(sessionId);
            continuationSystem = [
              goalText,
              workspaceGuidance(directory),
              roadmapCtx,
              "Reply in the same language the user writes in unless they ask otherwise.",
              VISIBLE_REPLY_GUARD,
            ]
              .filter(Boolean)
              .join("\n\n");
            continuationText =
              "[Continue — automated] You have finished reviewing the uploaded material " +
              "and updating the report. Now reply to the user in their language: briefly " +
              "confirm what you just recorded, then CONTINUE the interview by asking for " +
              "the next documents or information you still need. Use the roadmap above to " +
              "choose the most important still-open items, and ask specific, concrete " +
              "questions. Do NOT call any tools — just write the reply.";
            await promptAsync(sessionId, continuationText, {
              directory,
              system: continuationSystem,
            });
            // Arm the watchdog for the continuation turn too — it is a follow-on
            // promptAsync and must terminate even if the engine errors without idle.
            if (subagentWatchdog) clearTimeout(subagentWatchdog);
            subagentWatchdog = setTimeout(() => void doFinish(), SUBAGENT_WATCHDOG_MS);
            return true;
          } catch {
            return false;
          }
        };

        // Decide what to do when an idle signal arrives (from either
        // `session.status {idle}` or the terminal `session.idle`). Returns true
        // if the caller should doFinish()+break.
        const handleIdleSignal = async (): Promise<boolean> => {
          // Ignore any stray idle before a turn actually ran.
          if (!sawBusy) return false;

          if (!inSubagentPhase) {
            // MAIN or CONTINUATION turn just went idle.
            // Empty turn (no answer text, no tool calls) → re-fire the same prompt.
            if (!producedContent && retries < MAX_EMPTY_RETRIES) {
              retries++;
              sawBusy = false;
              producedContent = false;
              sawText = false;
              try {
                const refireText = inContinuationPhase ? continuationText : text;
                const refireSystem = inContinuationPhase
                  ? continuationSystem
                  : system;
                await promptAsync(sessionId, refireText, {
                  directory,
                  system: refireSystem,
                });
                return false; // keep the stream open for the retry's cycle
              } catch {
                return true; // re-fire failed → finish
              }
            }
            // The turn did work (tools) but produced NO visible text → drive a
            // continuation so the agent confirms + asks the next question. Only for
            // user-facing turns (a real user message or an upload notify), and only once.
            if (
              !inContinuationPhase &&
              !continuationFired &&
              !sawText &&
              (userText !== undefined || notify !== undefined)
            ) {
              continuationFired = true;
              inContinuationPhase = true;
              sawBusy = false;
              producedContent = false;
              sawText = false;
              if (await fireContinuation()) {
                return false; // keep the stream open for the continuation's cycle
              }
              // Couldn't fire the continuation → fall through to the sync turn.
            }
            // Main/continuation done → fire the hidden roadmap-sync turn (best-effort).
            if (!subagentFired) {
              subagentFired = true;
              inSubagentPhase = true;
              inContinuationPhase = false;
              subagentBusy = false;
              sawBusy = false;
              if (await fireRoadmapSync()) {
                return false; // keep the stream open for the sync turn
              }
              return true; // couldn't fire the sync → finish
            }
            return true;
          }

          // SUB-AGENT (roadmap-sync) phase.
          // Finish only once the sync turn actually ran (busy → idle). A stray
          // idle before the sync goes busy is ignored (the watchdog backstops it).
          if (subagentBusy) return true;
          return false;
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
              if (typeof delta === "string") {
                const isReasoning =
                  field === "reasoning" ||
                  (partID !== undefined && reasoningParts.has(partID));
                // Real answer text (not reasoning) counts as content for
                // empty-turn detection.
                if (!isReasoning && field === "text") {
                  producedContent = true;
                  sawText = true;
                  // Suppress the hidden roadmap-sync turn's reply text.
                  if (!inSubagentPhase) emit({ type: "text", delta });
                } else if (isReasoning) {
                  if (!inSubagentPhase) emit({ type: "reasoning", delta });
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
                // A tool call counts as content for empty-turn detection.
                producedContent = true;
                // Suppress the hidden roadmap-sync turn's tool chatter — the user
                // only sees the roadmap bar move, not the sync's tool calls.
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
              // Suppress status frames during the hidden sync turn (no UI flicker).
              if (!inSubagentPhase) emit({ type: "status", status: statusType });

              if (statusType === "busy") {
                sawBusy = true;
                if (inSubagentPhase) {
                  // The sync turn genuinely started — record that so handleIdleSignal
                  // waits for its real idle. Do NOT clear the watchdog here: if the
                  // engine goes busy then emits session.error without an idle, the
                  // watchdog is the only backstop that terminates the stream.
                  subagentBusy = true;
                }
              } else if (statusType === "idle") {
                if (await handleIdleSignal()) {
                  await doFinish();
                  break;
                }
              }
            } else if (type === "session.idle") {
              // Terminal event emitted once when the agent finishes its turn.
              if (!inSubagentPhase) emit({ type: "status", status: "idle" });
              if (await handleIdleSignal()) {
                await doFinish();
                break;
              }
            } else if (type === "session.error") {
              // The engine emits session.error when a turn fails (plugin hook
              // throws, context overflow with auto-compaction disabled, provider
              // error, etc.). In the ContextOverflow+auto-compaction path the
              // engine does NOT emit a subsequent session.status{idle} — so
              // without this handler the stream hangs forever.
              //
              // Payload: { sessionID, error: { type, message, ... } | undefined }
              const errorPayload = props["error"] as
                | { type?: string; message?: string }
                | undefined;
              const errorMsg =
                (typeof errorPayload?.message === "string"
                  ? errorPayload.message
                  : undefined) ??
                (typeof errorPayload?.type === "string"
                  ? errorPayload.type
                  : undefined) ??
                "Agent error";

              if (!inSubagentPhase) {
                // Surface the error to the user only on the main/continuation turn.
                // If we already streamed text (the main turn produced a good reply
                // and only a follow-on errored), don't clobber the good reply —
                // just finish silently.
                if (!sawText) {
                  emit({ type: "error", error: errorMsg });
                }
              }
              // Always terminate — session.error is a terminal signal.
              await doFinish();
              break;
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
