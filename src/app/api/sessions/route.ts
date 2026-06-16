export const runtime = "nodejs";

import { randomUUID } from "node:crypto";
import path from "node:path";
import { NextRequest } from "next/server";
import { getTask } from "@/lib/tasks";
import { createSession } from "@/lib/opencode";
import { ensureWorkspace, provisionWorkspace } from "@/lib/workspace";

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

    const workspaceId = randomUUID();
    const directory = path.posix.join(
      process.env.WORKSPACES_ROOT ?? "/workspaces",
      workspaceId
    );

    await provisionWorkspace(workspaceId, task);

    const { id: sessionId } = await createSession(
      `${task.label} report`,
      directory
    );

    await ensureWorkspace(sessionId, task, workspaceId);

    // TODO(scaffold): replace the file-backed workspace mapping with durable
    // session persistence once the BFF has a database.

    return Response.json({ sessionId });
  } catch (err) {
    console.error("[POST /api/sessions]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
