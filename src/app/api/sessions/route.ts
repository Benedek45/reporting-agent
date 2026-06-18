export const runtime = "nodejs";

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import { getGoal, readGoalRoadmap } from "@/lib/goals";
import { createSession, listSessions } from "@/lib/opencode";
import {
  ensureWorkspace,
  provisionWorkspace,
  readRoadmapState,
  readSessionState,
  writeAgentsStub,
  writeGoalFile,
  writeRoadmapFile,
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

    let sessionId: string;
    try {
      const result = await createSession(`${goal.title} report`, directory);
      sessionId = result.id;
    } catch (err) {
      // createSession failed — clean up the just-provisioned workspace so we
      // don't leave an orphaned directory on disk.
      const wsDir = path.posix.join(
        process.env.WORKSPACES_ROOT ?? "/workspaces",
        workspaceId
      );
      await fs.rm(wsDir, { recursive: true, force: true }).catch((rmErr) => {
        console.warn("[POST /api/sessions] orphan workspace cleanup failed:", rmErr);
      });
      throw err;
    }

    // Load the goal's detailed roadmap (if any) for first-turn injection +
    // the workspace progress checklist.
    const roadmapText = await readGoalRoadmap(goal);

    // Store goalText + roadmapText in session state so they can be injected on
    // the first turn without re-reading the goal file.
    await ensureWorkspace(sessionId, goal, workspaceId, {
      goalText: goal.body,
      ...(roadmapText ? { roadmapText } : {}),
    });
    await writeGoalFile(sessionId, goal);
    await writeRoadmapFile(sessionId, roadmapText);
    await writeAgentsStub(sessionId);

    // TODO(scaffold): replace the file-backed workspace mapping with durable
    // session persistence once the BFF has a database.

    const welcome = welcomeForGoal(goal.id, goal.title);

    return Response.json({ sessionId, welcome });
  } catch (err) {
    console.error("[POST /api/sessions]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}

function welcomeForGoal(goalId: string, title: string): string {
  if (goalId === "environment-qa") {
    return (
      "Hi - this is an environment Q&A session. Ask me about the current " +
      "workspace, available tools, MCP servers, files, goals, or how this app is configured."
    );
  }

  return (
    `Hi - I'll help you put together your ${title}. ` +
    "I'll ask a few questions and request documents as we go. " +
    "To get started, tell me about the organisation and reporting period this report should cover."
  );
}

/**
 * Returns all previous chats whose workspace lives under WORKSPACES_ROOT,
 * sorted by most recently updated.
 *
 * The opencode engine stores the working directory on every Session.Info,
 * so we filter to those whose `directory` starts with the BFF's workspaces
 * root (the same value POST used when creating the session). Anything
 * outside that prefix (e.g. dev sessions in a different tree) is excluded.
 *
 * `messageCount` and `roadmapPct` are sourced from the BFF's
 * `.sessions/<id>` state JSON when present (so the home page can show
 * progress and length without a per-session fetch).
 */
export async function GET(): Promise<Response> {
  const workspacesPrefix = path.posix.normalize(
    process.env.WORKSPACES_ROOT ?? "/workspaces"
  );

  let engineSessions: Array<{
    id: string;
    title?: string;
    directory?: string;
    time: { created: number; updated?: number };
  }> = [];
  try {
    engineSessions = await listSessions();
  } catch (err) {
    // Engine unreachable is non-fatal — return an empty list rather than
    // 500-ing the home page.
    console.error("[GET /api/sessions] listSessions failed:", err);
  }

  const summaries: Array<{
    id: string;
    title: string;
    goalHint: string | null;
    lastActivityMs: number;
    createdMs: number;
    messageCount: number;
    roadmapPct: number | null;
  }> = [];

  // Filter to sessions whose workspace lives under our workspaces root.
  const relevant = engineSessions.filter((s) => {
    if (!s.directory) return false;
    const dirNorm = path.posix.normalize(s.directory);
    return (
      dirNorm.startsWith(workspacesPrefix + path.posix.sep) ||
      dirNorm === workspacesPrefix
    );
  });

  // Parallelize per-session state + roadmap reads (was sequential for...of await).
  const summaryResults = await Promise.all(
    relevant.map(async (s) => {
      let messageCount = 0;
      let roadmapPct: number | null = null;
      try {
        const state = await readSessionState(s.id);
        messageCount = state.messageCount ?? 0;
        if (state.roadmapText) {
          const roadmap = await readRoadmapState(s.id);
          if (roadmap && roadmap.totalSteps > 0) {
            roadmapPct = roadmap.pct;
          }
        }
      } catch {
        // No state file — likely a child/subagent session
      }

      const title = s.title ?? "Untitled session";
      const goalHint = title.endsWith(" report")
        ? title.slice(0, -" report".length)
        : title;

      return {
        id: s.id,
        title,
        goalHint: title === "Untitled session" ? null : goalHint,
        lastActivityMs: s.time?.updated ?? s.time?.created ?? 0,
        createdMs: s.time?.created ?? 0,
        messageCount,
        roadmapPct,
      };
    })
  );

  for (const summary of summaryResults) {
    summaries.push(summary);
  }

  // Sort: most recently updated first
  summaries.sort((a, b) => b.lastActivityMs - a.lastActivityMs);

  return Response.json({ sessions: summaries });
}
