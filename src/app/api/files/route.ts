export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { listEnvFiles, canDeleteDirectly, deleteUpload } from "@/lib/workspace";
import type { EnvFile } from "@/types";

interface FilesResponse {
  files: EnvFile[];
}

/**
 * GET /api/files?sessionId=<id>
 * Returns the list of user-facing files for the session.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  if (!sessionId) {
    return Response.json({ error: "sessionId is required" }, { status: 400 });
  }

  try {
    const files = await listEnvFiles(sessionId);
    const response: FilesResponse = { files };
    return Response.json(response);
  } catch (err) {
    console.error("[GET /api/files]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/files
 * Body: { sessionId: string, name: string }
 * Deletes an upload directly if no message has been sent since upload;
 * otherwise returns 409 with an instruction to ask the model.
 */
export async function DELETE(req: NextRequest): Promise<Response> {
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

  try {
    const isDirect = await canDeleteDirectly(sessionId, name);
    if (!isDirect) {
      return Response.json(
        {
          error:
            "A message has been sent since this file was added — ask the model to remove it.",
        },
        { status: 409 }
      );
    }

    await deleteUpload(sessionId, name);
    return Response.json({ deleted: true });
  } catch (err) {
    console.error("[DELETE /api/files]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
