export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { getTask } from "@/lib/tasks";
import { createSession } from "@/lib/opencode";
import { ensureWorkspace } from "@/lib/workspace";

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const body = (await req.json()) as { taskId?: string };
    const { taskId } = body;

    if (!taskId) {
      return Response.json({ error: "taskId is required" }, { status: 400 });
    }

    const task = getTask(taskId);
    if (!task) {
      return Response.json(
        { error: `Unknown taskId: ${taskId}` },
        { status: 400 }
      );
    }

    const { id: sessionId } = await createSession(`${task.label} report`);

    await ensureWorkspace(sessionId, task);

    // TODO(scaffold): persist the session<->workspace association (e.g. in a
    // lightweight SQLite or JSON store) so that subsequent requests can look up
    // the workspace by sessionId without relying on the filesystem naming
    // convention alone. Currently the workspace directory IS named by sessionId,
    // which is sufficient for the scaffold but fragile if session IDs change.

    return Response.json({ sessionId });
  } catch (err) {
    console.error("[POST /api/sessions]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
