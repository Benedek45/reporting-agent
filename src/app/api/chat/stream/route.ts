export const runtime = "nodejs";

import { NextRequest } from "next/server";
import {
  openEventStream,
  promptAsync,
  getSessionTokensDetail,
  getProviderContextLimit,
  revertSession,
} from "@/lib/opencode";
import {
  incrementMessageCount,
  sessionDirectory,
  readSessionState,
  readUploadMarkdown,
  addLoadedContextBytes,
  bumpTimeIfDue,
  getGoalText,
} from "@/lib/workspace";
import type { StreamEvent, TodoItem, ContextBreakdownItem } from "@/types";

const TIMEOUT_MS = 180_000; // 3 minutes safety timeout
const MAX_CONTEXT_FILE_BYTES = Number(
  process.env.MAX_CONTEXT_FILE_BYTES ?? 200_000
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
export async function POST(req: NextRequest): Promise<Response> {
  let sessionId: string;
  let userText: string | undefined;
  let editMessageId: string | undefined;
  let loadFileName: string | undefined;

  try {
    const body = (await req.json()) as {
      sessionId?: string;
      text?: string;
      editMessageId?: string;
      loadFileName?: string;
    };
    if (!body.sessionId || typeof body.sessionId !== "string") {
      return Response.json({ error: "sessionId is required" }, { status: 400 });
    }
    sessionId = body.sessionId;
    userText = body.text;
    editMessageId = body.editMessageId;
    loadFileName = body.loadFileName;

    // Must have either text or loadFileName
    if (!userText && !loadFileName) {
      return Response.json(
        { error: "text or loadFileName is required" },
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

        // Step 3: increment message count
        await incrementMessageCount(sessionId);

        // Step 4: build system string
        const state = await readSessionState(sessionId);
        const isFirstTurn = state.messageCount === 1;

        const systemParts: string[] = [];

        const timeStr = await bumpTimeIfDue(sessionId);
        if (timeStr) systemParts.push(timeStr);

        if (isFirstTurn) {
          const goalText = await getGoalText(sessionId);
          if (goalText) systemParts.push(goalText);
        }

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

        const system = systemParts.filter(Boolean).join("\n\n");

        // Determine the user-visible text
        const text =
          loadFileName && !userText
            ? `Please review the document "${loadFileName}" I've loaded into context.`
            : (userText as string);

        // Step 5: open upstream SSE BEFORE prompting to avoid missing early events
        upstreamRes = await openEventStream(directory);

        // Step 6: fire the async prompt
        await promptAsync(sessionId, text, { directory, system });

        // Step 7: parse upstream SSE and relay filtered events
        const body = upstreamRes.body;
        if (!body) {
          throw new Error("Upstream /event response has no body");
        }

        let sawBusy = false;
        let done = false;
        // partIDs whose deltas are the model's internal reasoning (not the answer)
        const reasoningParts = new Set<string>();

        // Safety timeout
        timeoutHandle = setTimeout(() => {
          if (!done) {
            done = true;
            emit({ type: "done" });
            close();
          }
        }, TIMEOUT_MS);

        const doFinish = async (): Promise<void> => {
          if (done) return;
          done = true;
          try {
            const [tokensDetail, contextLimit] = await Promise.all([
              getSessionTokensDetail(sessionId),
              getProviderContextLimit(),
            ]);

            const usedTokens =
              (tokensDetail.input ?? 0) +
              (tokensDetail.output ?? 0) +
              (tokensDetail.cache?.read ?? 0) +
              (tokensDetail.cache?.write ?? 0);

            const pct = Math.min(
              100,
              Math.round((usedTokens / contextLimit) * 100)
            );

            // Build breakdown (approximate — labeled as such)
            const reasoningTokens = tokensDetail.reasoning ?? 0;

            // Re-read state to get latest loadedContextBytes
            const latestState = await readSessionState(sessionId).catch(
              () => state
            );
            const documentTokens = Math.ceil(
              (latestState.loadedContextBytes ?? 0) / 4
            );
            const systemBaseline = 6000; // approximate constant
            const conversationTokens = Math.max(
              0,
              usedTokens - reasoningTokens - documentTokens - systemBaseline
            );

            const breakdown: ContextBreakdownItem[] = [
              { label: "Reasoning", tokens: reasoningTokens },
              { label: "Documents", tokens: documentTokens },
              { label: "System & tools (approx.)", tokens: systemBaseline },
              { label: "Conversation", tokens: conversationTokens },
            ];

            emit({ type: "usage", usedTokens, contextLimit, pct, breakdown });
          } catch {
            // Non-fatal — skip usage frame
          }
          emit({ type: "done" });
          if (timeoutHandle) clearTimeout(timeoutHandle);
          close();
        };

        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!done) {
          const { value, done: streamDone } = await reader.read();
          if (streamDone) break;

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
                // Emit tool event
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
              emit({ type: "status", status: statusType });

              if (statusType === "busy") {
                sawBusy = true;
              } else if (statusType === "idle" && sawBusy) {
                await doFinish();
                break;
              }
            } else if (type === "session.idle") {
              // Terminal event emitted once when the agent finishes its turn.
              emit({ type: "status", status: "idle" });
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
      } catch (err) {
        if (timeoutHandle) clearTimeout(timeoutHandle);
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
