export const runtime = "nodejs";

// TODO(scaffold): stream via SSE instead of awaiting full reply.
// Replace this handler with a streaming response using ReadableStream /
// TransformStream, consuming GET /event from the opencode server and
// forwarding token chunks to the client.

import { NextRequest } from "next/server";
import { sendMessage } from "@/lib/opencode";

// Minimal workspace guidance injected on the legacy non-streaming path so the
// agent is aware of the merged folder layout and deliverable conventions.
const WORKSPACE_GUIDANCE =
  "All files (uploads and the report) live in one folder. " +
  "Continue writing the report to `output/report.md`. " +
  "If you produce any other deliverable, call `present_file` with its absolute path.";

const VISIBLE_REPLY_GUARD =
  "Your visible assistant message must contain only the final user-facing reply. " +
  "Do NOT include internal setup, planning, self-instructions, or tool narration. " +
  "Never write phrases like `The skill is loaded`, `Now I need to`, `I will combine`, " +
  "`The user said`, or a `Plan:` section.";

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const body = (await req.json()) as {
      sessionId?: string;
      text?: string;
    };

    const { sessionId, text } = body;

    if (!sessionId || !text) {
      return Response.json(
        { error: "sessionId and text are required" },
        { status: 400 }
      );
    }

    const { text: reply } = await sendMessage(sessionId, text, {
      system: `${WORKSPACE_GUIDANCE}\n\n${VISIBLE_REPLY_GUARD}`,
    });

    return Response.json({ reply });
  } catch (err) {
    console.error("[POST /api/chat]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
