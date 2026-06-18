import { getGoals } from "@/lib/goals";
import GoalPicker from "@/app/_components/GoalPicker";
import SessionList, { type SessionSummary } from "@/app/_components/SessionList";
import { listSessions } from "@/lib/opencode";
import { readRoadmapState, readSessionState } from "@/lib/workspace";
import path from "node:path";

// Reads goals/*.md from the filesystem at request time — must not be statically
// prerendered at build (where goals/ is absent), or the dropdown bakes in empty.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const goals = await getGoals();
  const goalOptions = goals.map((g) => ({ id: g.id, title: g.title }));

  const initialSessions = await loadSessionSummaries();

  return (
    <main className="home-page">
      <h1>Reporting Agent</h1>
      <p>Select a report type to begin. The AI will interview you and draft the report.</p>
      <GoalPicker goals={goalOptions} />
      <SessionList initial={initialSessions} />
    </main>
  );
}

/**
 * Server-side equivalent of what SessionList does client-side. Best-effort:
 * if the engine or state file can't be read, we return an empty list rather
 * than crashing the home page render.
 */
async function loadSessionSummaries(): Promise<SessionSummary[]> {
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
    console.error("[HomePage] listSessions failed:", err);
    return [];
  }

  const out: SessionSummary[] = [];
  for (const s of engineSessions) {
    if (!s.directory) continue;
    const dirNorm = path.posix.normalize(s.directory);
    if (
      !dirNorm.startsWith(workspacesPrefix + path.posix.sep) &&
      dirNorm !== workspacesPrefix
    ) {
      continue;
    }

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
      // No state file — child/subagent session
    }

    const title = s.title ?? "Untitled session";
    const goalHint = title.endsWith(" report")
      ? title.slice(0, -" report".length)
      : null;

    out.push({
      id: s.id,
      title,
      goalHint: title === "Untitled session" ? null : goalHint,
      lastActivityMs: s.time?.updated ?? s.time?.created ?? 0,
      createdMs: s.time?.created ?? 0,
      messageCount,
      roadmapPct,
    });
  }

  out.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  return out;
}
