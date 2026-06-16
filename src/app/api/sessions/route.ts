export const runtime = "nodejs";

import { randomUUID } from "node:crypto";
import path from "node:path";
import { NextRequest } from "next/server";
import { getGoal } from "@/lib/goals";
import { createSession } from "@/lib/opencode";
import {
  ensureWorkspace,
  provisionWorkspace,
  writeGoalFile,
} from "@/lib/workspace";

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const body = (await req.json()) as { goalId?: string; taskId?: string };

    // Accept goalId; fall back to legacy taskId for backwards compatibility
    const goalId = body.goalId ?? body.taskId;

    if (!goalId) {
      return Response.json({ error: "goalId is required" }, { status: 400 });
    }

    const goal = await getGoal(goalId);
    if (!goal) {
      return Response.json(
        { error: `Unknown goalId: ${goalId}` },
        { status: 400 }
      );
    }

    const workspaceId = randomUUID();
    const directory = path.posix.join(
      process.env.WORKSPACES_ROOT ?? "/workspaces",
      workspaceId
    );

    await provisionWorkspace(workspaceId, goal);

    const { id: sessionId } = await createSession(
      `${goal.title} report`,
      directory
    );

    // Store goalText in session state so it can be injected on the first turn
    // without re-reading the goal file.
    await ensureWorkspace(sessionId, goal, workspaceId, { goalText: goal.body });
    await writeGoalFile(sessionId, goal);

    // TODO(scaffold): replace the file-backed workspace mapping with durable
    // session persistence once the BFF has a database.

    const welcome =
      `Hi — I'll help you put together your ${goal.title}. ` +
      `I'll ask a few questions and request documents as we go. ` +
      `To get started, tell me about the organisation and reporting period this report should cover.`;

    return Response.json({ sessionId, welcome });
  } catch (err) {
    console.error("[POST /api/sessions]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
