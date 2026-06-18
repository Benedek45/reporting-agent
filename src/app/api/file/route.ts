export const runtime = "nodejs";

import { NextRequest } from "next/server";
import path from "node:path";
import { readWorkspaceText, writeWorkspaceText } from "@/lib/workspace";

function isSafeName(name: string): boolean {
  const base = path.basename(name);
  return base === name && base !== "" && base !== "." && base !== "..";
}

/**
 * GET /api/file?sessionId=&name=
 * Returns the agent-visible text content of a workspace file for the editor.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  const name = req.nextUrl.searchParams.get("name");

  if (!sessionId) {
    return Response.json({ error: "sessionId is required" }, { status: 400 });
  }
  if (!name || !isSafeName(name)) {
    return Response.json({ error: "valid name is required" }, { status: 400 });
  }

  try {
    const content = await readWorkspaceText(sessionId, name);
    return Response.json({ name, content });
  } catch {
    return Response.json({ error: "File not found" }, { status: 404 });
  }
}

/**
 * PUT /api/file
 * Body: { sessionId, name, content }
 * Saves edited text and returns the unified diff of the change so the caller
 * can notify the agent.
 */
export async function PUT(req: NextRequest): Promise<Response> {
  let sessionId: string;
  let name: string;
  let content: string;

  try {
    const body = (await req.json()) as {
      sessionId?: string;
      name?: string;
      content?: string;
    };
    if (!body.sessionId || typeof body.sessionId !== "string") {
      return Response.json({ error: "sessionId is required" }, { status: 400 });
    }
    if (!body.name || !isSafeName(body.name)) {
      return Response.json({ error: "valid name is required" }, { status: 400 });
    }
    if (typeof body.content !== "string") {
      return Response.json({ error: "content is required" }, { status: 400 });
    }
    sessionId = body.sessionId;
    name = body.name;
    content = body.content;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const { diff } = await writeWorkspaceText(sessionId, name, content);
    return Response.json({ name, diff });
  } catch (err) {
    console.error("[PUT /api/file]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
