export const runtime = "nodejs";

// TODO(scaffold): stream via SSE instead of awaiting full reply.
// Replace this handler with a streaming response using ReadableStream /
// TransformStream, consuming GET /event from the opencode server and
// forwarding token chunks to the client.

import { NextRequest } from "next/server";
import { sendMessage } from "@/lib/opencode";

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

    const { text: reply } = await sendMessage(sessionId, text);

    return Response.json({ reply });
  } catch (err) {
    console.error("[POST /api/chat]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
