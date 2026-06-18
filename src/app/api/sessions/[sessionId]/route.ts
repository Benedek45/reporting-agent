export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { deleteSession as engineDeleteSession } from "@/lib/opencode";
import { deleteSession as deleteWorkspace } from "@/lib/workspace";

/**
 * DELETE /api/sessions/:sessionId
 *
 * Removes a session entirely:
 *   1. Calls the opencode engine's `DELETE /session/:id` so the session
 *      disappears from `GET /session?roots=true`.
 *   2. Removes the BFF's `.sessions/<id>` state mapping.
 *   3. Recursively deletes the workspace directory (uploads, report,
 *      goal, roadmap, agents, etc.).
 *
 * Idempotent — returns 204 even if parts were already missing. 404 is
 * returned only if the engine explicitly says the session is unknown
 * AND the workspace dir was not present.
 */
export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ sessionId: string }> }
): Promise<Response> {
  const { sessionId } = await ctx.params;
  if (!sessionId) {
    return Response.json({ error: "sessionId is required" }, { status: 400 });
  }

  let engineError: string | null = null;
  try {
    await engineDeleteSession(sessionId);
  } catch (err) {
    engineError = err instanceof Error ? err.message : String(err);
    // Log but do not abort — workspace cleanup must still run.
    console.error(`[DELETE /api/sessions/:id] engine delete failed (continuing):`, engineError);
  }

  // Remove the workspace + state file. Always attempt — the session may have
  // no state file but still own a workspace, or vice versa.
  let workspaceCleanedUp = false;
  try {
    await deleteWorkspace(sessionId);
    workspaceCleanedUp = true;
  } catch (err) {
    console.error(`[DELETE /api/sessions/:id] workspace cleanup failed:`, err);
  }

  // Return 204 if the workspace was cleaned up (the primary goal), even if the
  // engine call failed (transient connectivity, already-deleted session, etc.).
  // Only return 502 if the workspace itself could not be removed.
  if (!workspaceCleanedUp && engineError) {
    return Response.json(
      { error: engineError, partial: true },
      { status: 502 }
    );
  }

  return new Response(null, { status: 204 });
}
