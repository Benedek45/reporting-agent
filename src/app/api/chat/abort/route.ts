export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { abortSession } from "@/lib/opencode";
import { sessionDirectory } from "@/lib/workspace";

/**
 * POST /api/chat/abort
 * Body: { sessionId: string }
 * Aborts the current in-progress turn for the session.
 */
export async function POST(req: NextRequest): Promise<Response> {
  let sessionId: string;

  try {
    const body = (await req.json()) as { sessionId?: string };
    if (!body.sessionId || typeof body.sessionId !== "string") {
      return Response.json({ error: "sessionId is required" }, { status: 400 });
    }
    sessionId = body.sessionId;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const directory = await sessionDirectory(sessionId);
    await abortSession(sessionId, directory);
    return Response.json({ aborted: true });
  } catch (err) {
    console.error("[POST /api/chat/abort]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
