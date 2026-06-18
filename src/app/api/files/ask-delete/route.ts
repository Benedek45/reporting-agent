export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { sendMessage } from "@/lib/opencode";
import { isSafeName } from "@/lib/workspace";

interface AskDeleteResponse {
  reply: string;
}

/**
 * POST /api/files/ask-delete
 * Body: { sessionId: string, name: string }
 * Asks the compliance agent to delete the named file from the workspace.
 */
export async function POST(req: NextRequest): Promise<Response> {
  let sessionId: string;
  let name: string;

  try {
    const body = (await req.json()) as { sessionId?: string; name?: string };
    if (!body.sessionId || typeof body.sessionId !== "string") {
      return Response.json({ error: "sessionId is required" }, { status: 400 });
    }
    if (!body.name || typeof body.name !== "string") {
      return Response.json({ error: "name is required" }, { status: 400 });
    }
    sessionId = body.sessionId;
    name = body.name;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Reject path-traversal / prompt-injection: name must be a safe basename.
  if (!isSafeName(name)) {
    return Response.json({ error: "Invalid file name" }, { status: 400 });
  }

  try {
    const prompt =
      `Please delete the uploaded file "${name}" from this workspace using your delete_file tool, ` +
      `then briefly confirm and note any report sections that relied on it.`;

    const { text: reply } = await sendMessage(sessionId, prompt);

    const response: AskDeleteResponse = { reply };
    return Response.json(response);
  } catch (err) {
    console.error("[POST /api/files/ask-delete]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
