// server-only

import fs from "node:fs/promises";
import path from "node:path";
import type { Goal } from "@/types";

export type { Goal };

const GOALS_DIR = path.join(process.cwd(), "goals");

/**
 * Minimal frontmatter parser.
 * Expects the file to start with `---\n`, reads key: value lines until the
 * next line that is exactly `---`, and treats the remainder as the body.
 * Returns null if the file does not start with a frontmatter block.
 */
function parseFrontmatter(
  content: string
): { meta: Record<string, string>; body: string } | null {
  if (!content.startsWith("---\n")) return null;

  const afterOpen = content.slice(4); // skip opening `---\n`
  const closeIdx = afterOpen.indexOf("\n---\n");
  if (closeIdx === -1) return null;

  const fmBlock = afterOpen.slice(0, closeIdx);
  const body = afterOpen.slice(closeIdx + 5).trim(); // skip `\n---\n`

  const meta: Record<string, string> = {};
  for (const line of fmBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const raw = line.slice(colonIdx + 1).trim();
    // Strip surrounding single or double quotes
    const value =
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
        ? raw.slice(1, -1)
        : raw;
    if (key) meta[key] = value;
  }

  return { meta, body };
}

function goalFromFile(
  content: string,
  fileName: string
): Goal | null {
  const parsed = parseFrontmatter(content);
  if (!parsed) return null;

  const { meta, body } = parsed;
  const id = meta["id"];
  const title = meta["title"];
  const agent = meta["agent"];
  const skill = meta["skill"];
  const templatePath = meta["template"]; // frontmatter key is `template`
  const roadmapPath = meta["roadmap"]; // optional
  // `dev: true` marks a goal as developer-only (excluded from the dropdown
  // unless SHOW_DEV_GOALS=1). Accepts "true" (string from YAML frontmatter).
  const dev = meta["dev"] === "true";

  if (!id || !title || !agent || !skill || !templatePath) {
    console.warn(`[goals] Skipping ${fileName}: missing required frontmatter field`);
    return null;
  }

  return {
    id,
    title,
    agent,
    skill,
    templatePath,
    ...(roadmapPath ? { roadmapPath } : {}),
    ...(dev ? { dev: true } : {}),
    body,
  };
}

/**
 * Reads the roadmap markdown body for a goal (from its `roadmap` frontmatter
 * path, resolved against the repo root). Returns "" if the goal has no roadmap
 * or the file is unreadable.
 */
export async function readGoalRoadmap(goal: Goal): Promise<string> {
  if (!goal.roadmapPath) return "";
  try {
    return await fs.readFile(
      path.resolve(process.cwd(), goal.roadmapPath),
      "utf8"
    );
  } catch (err) {
    console.warn(
      `[goals] Could not read roadmap for ${goal.id} at ${goal.roadmapPath}: ${String(err)}`
    );
    return "";
  }
}

export async function getGoals(): Promise<Goal[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(GOALS_DIR);
  } catch {
    return [];
  }

  const showDev = process.env.SHOW_DEV_GOALS === "1";

  const goals: Goal[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    try {
      const content = await fs.readFile(path.join(GOALS_DIR, entry), "utf8");
      const goal = goalFromFile(content, entry);
      if (!goal) continue;
      // Exclude developer-only goals from the dropdown unless SHOW_DEV_GOALS=1.
      if (goal.dev && !showDev) continue;
      goals.push(goal);
    } catch (err) {
      console.warn(`[goals] Could not read ${entry}: ${String(err)}`);
    }
  }

  return goals.sort((a, b) => a.title.localeCompare(b.title));
}

export async function getGoal(id: string): Promise<Goal | undefined> {
  const goals = await getGoals();
  return goals.find((g) => g.id === id);
}
