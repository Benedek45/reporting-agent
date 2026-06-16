export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { getMessages } from "@/lib/opencode";
import { sessionDirectory } from "@/lib/workspace";
import type { MessageHistoryItem } from "@/types";

interface MessagesResponse {
  messages: MessageHistoryItem[];
}

/**
 * GET /api/session/:sessionId/messages
 * Returns the full message history for a session.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
): Promise<Response> {
  const { sessionId } = await params;

  if (!sessionId) {
    return Response.json({ error: "sessionId is required" }, { status: 400 });
  }

  try {
    const directory = await sessionDirectory(sessionId);
    const messages = await getMessages(sessionId, directory);
    const response: MessagesResponse = { messages };
    return Response.json(response);
  } catch (err) {
    console.error(`[GET /api/session/${sessionId}/messages]`, err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
