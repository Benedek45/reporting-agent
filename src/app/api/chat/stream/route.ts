export const runtime = "nodejs";

import { NextRequest } from "next/server";
import {
  openEventStream,
  promptAsync,
  getSessionTokens,
  getProviderContextLimit,
} from "@/lib/opencode";
import { incrementMessageCount, sessionDirectory } from "@/lib/workspace";
import type { StreamEvent, TodoItem } from "@/types";

const TIMEOUT_MS = 180_000; // 3 minutes safety timeout

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
 * Body: { sessionId: string, text: string }
 * Returns: text/event-stream
 *
 * Downstream SSE protocol:
 *   { type: "text",   delta: string }
 *   { type: "todos",  todos: TodoItem[] }
 *   { type: "status", status: string }
 *   { type: "usage",  usedTokens: number, contextLimit: number, pct: number }
 *   { type: "done" }
 *   { type: "error",  error: string }
 */
export async function POST(req: NextRequest): Promise<Response> {
  let sessionId: string;
  let text: string;

  try {
    const body = (await req.json()) as { sessionId?: string; text?: string };
    if (!body.sessionId || typeof body.sessionId !== "string") {
      return Response.json({ error: "sessionId is required" }, { status: 400 });
    }
    if (!body.text || typeof body.text !== "string") {
      return Response.json({ error: "text is required" }, { status: 400 });
    }
    sessionId = body.sessionId;
    text = body.text;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
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
        // Step 1: increment message count
        await incrementMessageCount(sessionId);

        // The engine pre-filters /event by the session's directory, so we MUST
        // open the stream (and prompt) with the same ?directory= the session is
        // bound to, otherwise none of this session's events reach us.
        const directory = await sessionDirectory(sessionId);

        // Step 2: open upstream SSE BEFORE prompting to avoid missing early events
        upstreamRes = await openEventStream(directory);

        // Step 3: fire the async prompt
        await promptAsync(sessionId, text, { directory });

        // Step 4: parse upstream SSE and relay filtered events
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
            const [usedTokens, contextLimit] = await Promise.all([
              getSessionTokens(sessionId),
              getProviderContextLimit(),
            ]);
            const pct = Math.min(100, Math.round((usedTokens / contextLimit) * 100));
            emit({ type: "usage", usedTokens, contextLimit, pct });
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
            const props = parsed["properties"] as Record<string, unknown> | undefined;

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
              const part = props["part"] as { type?: string; id?: string } | undefined;
              if (part?.type === "reasoning" && typeof part.id === "string") {
                reasoningParts.add(part.id);
              }
            } else if (type === "todo.updated") {
              const todos = props["todos"] as TodoItem[] | undefined;
              if (Array.isArray(todos)) {
                emit({ type: "todos", todos });
              }
            } else if (type === "session.status") {
              const statusObj = props["status"] as { type?: string } | undefined;
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
