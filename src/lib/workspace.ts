// server-only

import fs from "node:fs/promises";
import path from "node:path";
import type {
  Goal,
  SessionState,
  UploadInfo,
  EnvFile,
  DownloadFormat,
  RoadmapState,
  RoadmapSection,
} from "@/types";

const REPO_ROOT = process.cwd();

// The single per-session folder that holds BOTH user uploads and the agent's
// output (the report). Uploaded files and `report.md` live side by side here.
// (Previously uploads lived in `uploads/` and the report in `output/`; these
// were merged so the user sees one folder.)
const FILES_SUBDIR = "output";

// Files inside FILES_SUBDIR that are NOT user documents and must be hidden from
// upload/file listings. `report.md` is surfaced separately as kind "report".
const SYSTEM_FILES = new Set([
  "report-template.md",
  ".presented",
]);

/** Name of the per-chat local memory file (the user's editable AGENTS.md,
 * like Claude.md — the model's long-term memory that survives compaction).
 * All-caps to match the opencode/AGENTS.md convention. */
export const AGENTS_FILE_NAME = "AGENTS.md";

function workspacesRoot(): string {
  if (!process.env.WORKSPACES_ROOT) {
    console.warn(
      "[workspace] WORKSPACES_ROOT is not set — falling back to " +
        "'../reporting-agent-workspaces'. Set WORKSPACES_ROOT to the path the " +
        "opencode engine sees (e.g. /workspaces in Docker) to avoid misrouting."
    );
  }
  return path.resolve(
    REPO_ROOT,
    process.env.WORKSPACES_ROOT ?? "../reporting-agent-workspaces"
  );
}

/**
 * Shared basename safety check. Returns true iff `name` is a safe file
 * basename: no path separators, not empty, not `.` or `..`.
 * Use this at route layer before embedding `name` in prompts or file paths.
 */
export function isSafeName(name: string): boolean {
  const base = path.basename(name);
  return base === name && base !== "" && base !== "." && base !== "..";
}

export function workspaceDir(sessionId: string): string {
  return path.join(workspacesRoot(), sessionId);
}

/**
 * Returns the directory the opencode ENGINE sees for this session
 * (e.g. `/workspaces/<uuid>`). This is the value that was passed to
 * `createSession(..., directory)` and must be passed as `?directory=` on
 * `/event` and `/prompt_async` so the engine routes the session's events to us.
 */
export async function sessionDirectory(sessionId: string): Promise<string> {
  return workspaceDirForSession(sessionId);
}

function mappingDir(): string {
  return path.join(workspacesRoot(), ".sessions");
}

function mappedWorkspaceDirName(sessionId: string): string {
  return path.basename(sessionId).replace(/[/\\]/g, "_");
}

// ── Session state (JSON mapping file) ─────────────────────────────────────────

/**
 * Reads the session state from the mapping file.
 * Backward-compatible: if the file contains a bare UUID string (not JSON),
 * returns { workspaceId: <that>, messageCount: 0, uploads: {} }.
 */
export async function readSessionState(sessionId: string): Promise<SessionState> {
  const filePath = path.join(mappingDir(), mappedWorkspaceDirName(sessionId));

  // A concurrent writer may briefly leave the file torn on some platforms.
  // Writes are atomic (temp + rename) so this should not happen, but we retry
  // once on a parse failure as cheap insurance against a transient bad read.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch {
      throw new Error(`Session state not found for sessionId: ${sessionId}`);
    }

    const trimmed = raw.trim();

    // Detect legacy bare-UUID format (no braces)
    if (!trimmed.startsWith("{")) {
      return { workspaceId: trimmed, messageCount: 0, uploads: {} };
    }

    try {
      return JSON.parse(trimmed) as SessionState;
    } catch (err) {
      lastErr = err;
      // brief pause, then re-read once
      await new Promise((r) => setTimeout(r, 15));
    }
  }
  throw new Error(
    `Corrupt session state for ${sessionId}: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`
  );
}

/**
 * Writes data to `target` atomically: writes to a unique sibling temp file
 * then renames over the target. rename(2) is atomic on a single filesystem,
 * so concurrent readers always observe a complete file.
 */
async function atomicWriteFile(
  target: string,
  data: string | Uint8Array,
  encoding?: BufferEncoding
): Promise<void> {
  const { randomUUID } = await import("node:crypto");
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  if (typeof data === "string") {
    await fs.writeFile(tmp, data, encoding ?? "utf8");
  } else {
    await fs.writeFile(tmp, data);
  }
  try {
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Writes the session state to the mapping file ATOMICALLY (write to a unique
 * temp file, then rename over the target). rename(2) is atomic on a single
 * filesystem, so concurrent readers always observe a complete file — never a
 * torn "valid JSON + leftover tail" that would crash JSON.parse.
 */
export async function writeSessionState(
  sessionId: string,
  state: SessionState
): Promise<void> {
  const dir = mappingDir();
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, mappedWorkspaceDirName(sessionId));
  await atomicWriteFile(target, JSON.stringify(state), "utf8");
}

// ── Per-session state mutation lock ─────────────────────────────────────────
//
// All read-modify-write cycles on the session-state JSON run in this single
// Node process. Several of them fire concurrently (notably the fire-and-forget
// `recordReadDocBytes` calls during a turn where the agent reads many files).
// Without serialization, concurrent cycles lose updates and — combined with
// non-atomic writes — could produce torn reads. We chain mutations per session
// through a promise so each read-modify-write is applied atomically end-to-end.
// Pruned after each settled mutation to prevent unbounded growth in long-lived
// processes (e.g. many sessions created and deleted over the app's lifetime).
const _stateLocks = new Map<string, Promise<unknown>>();

/**
 * Runs `mutator` under the per-session state lock: reads the latest state,
 * lets the mutator change it (optionally returning a value), writes it back
 * atomically, and returns the mutator's value. Serialized per sessionId.
 */
export async function updateSessionState<T>(
  sessionId: string,
  mutator: (state: SessionState) => T | Promise<T>
): Promise<T> {
  const prev = _stateLocks.get(sessionId) ?? Promise.resolve();
  const run = prev.then(async () => {
    const state = await readSessionState(sessionId);
    const result = await mutator(state);
    await writeSessionState(sessionId, state);
    return result;
  });
  // Keep the chain alive even if this link rejects (so later mutations still run).
  const settled = run.catch(() => {});
  _stateLocks.set(sessionId, settled);
  // Prune the entry once settled so the map doesn't grow unboundedly over the
  // process lifetime (many sessions created and deleted).
  void settled.then(() => {
    if (_stateLocks.get(sessionId) === settled) {
      _stateLocks.delete(sessionId);
    }
  });
  return run;
}

/**
 * Atomically increments the message count for a session and returns the new count.
 */
export async function incrementMessageCount(sessionId: string): Promise<number> {
  return updateSessionState(sessionId, (state) => {
    state.messageCount += 1;
    return state.messageCount;
  });
}

/**
 * Records that a file was uploaded at the current message count.
 */
export async function recordUpload(
  sessionId: string,
  fileName: string
): Promise<void> {
  const safeName = path.basename(fileName).replace(/[/\\]/g, "_");
  await updateSessionState(sessionId, (state) => {
    state.uploads[safeName] = state.messageCount;
  });
}

/**
 * Returns true iff the file was uploaded at the current message count
 * (i.e. no message has been sent since the upload, so the model hasn't seen it).
 */
export async function canDeleteDirectly(
  sessionId: string,
  fileName: string
): Promise<boolean> {
  const state = await readSessionState(sessionId);
  const safeName = path.basename(fileName).replace(/[/\\]/g, "_");
  const uploadedAt = state.uploads[safeName];
  if (uploadedAt === undefined) return false;
  return uploadedAt === state.messageCount;
}

/**
 * Deletes an upload file, its .md sidecar, and removes it from the uploads map.
 */
export async function deleteUpload(
  sessionId: string,
  fileName: string
): Promise<void> {
  const safeName = path.basename(fileName).replace(/[/\\]/g, "_");
  const wsDir = await workspaceDirForSession(sessionId);
  const uploadsDir = path.join(wsDir, FILES_SUBDIR);

  // Update state FIRST so canDeleteDirectly never returns true for a file that
  // is already gone (a crash between file deletion and state update would leave
  // a stale entry that could confuse the UI).
  await updateSessionState(sessionId, (state) => {
    delete state.uploads[safeName];
  });

  // Remove the source file
  try {
    await fs.unlink(path.join(uploadsDir, safeName));
  } catch {
    // Ignore if already gone
  }

  // Remove the .md sidecar
  try {
    await fs.unlink(path.join(uploadsDir, `${safeName}.md`));
  } catch {
    // Ignore if no sidecar
  }
}

/**
 * Lists user-facing files for a session:
 * - uploads/ entries (excluding .md sidecars whose base exists), kind "upload"
 * - output/report.md (as name "report.md", kind "report") if present
 * NOTE: goal.md is intentionally excluded from this listing.
 */
export async function listEnvFiles(sessionId: string): Promise<EnvFile[]> {
  const wsDir = await workspaceDirForSession(sessionId);
  const filesDir = path.join(wsDir, FILES_SUBDIR);
  const state = await readSessionState(sessionId).catch(() => ({
    workspaceId: sessionId,
    messageCount: 0,
    uploads: {} as Record<string, number>,
  }));

  const presented = await readPresented(sessionId);

  const results: EnvFile[] = [];

  let entries: string[] = [];
  try {
    entries = await fs.readdir(filesDir);
  } catch {
    // No folder yet
  }

  const entrySet = new Set(entries);

  for (const entry of entries) {
    // The report is surfaced explicitly below; system files are hidden.
    if (entry === "report.md" || SYSTEM_FILES.has(entry)) continue;
    // Skip .md sidecars whose base file also exists
    if (entry.endsWith(".md")) {
      const base = entry.slice(0, -3);
      if (entrySet.has(base)) continue;
    }

    try {
      const stat = await fs.stat(path.join(filesDir, entry));
      if (!stat.isFile()) continue;

      const ext = path.extname(entry).toLowerCase();
      const isPresented = presented.has(entry);
      const uploadedAt = state.uploads[entry];
      const isDirect =
        !isPresented &&
        uploadedAt !== undefined &&
        uploadedAt === state.messageCount;
      const formats: DownloadFormat[] =
        ext === ".md"
          ? (["md", "pdf", "docx"] as DownloadFormat[])
          : (["original", "md", "pdf", "docx"] as DownloadFormat[]);

      results.push({
        name: entry,
        kind: isPresented ? "presented" : "upload",
        size: stat.size,
        ext,
        canDeleteDirectly: isDirect,
        downloadFormats: formats,
      });
    } catch {
      // Skip unreadable entries
    }
  }

  // report.md — the primary deliverable, always grouped as a presented output.
  const reportPath = path.join(filesDir, "report.md");
  try {
    const stat = await fs.stat(reportPath);
    if (stat.isFile()) {
      results.push({
        name: "report.md",
        kind: "report",
        size: stat.size,
        ext: ".md",
        canDeleteDirectly: false,
        downloadFormats: ["md", "pdf", "docx"] as DownloadFormat[],
      });
    }
  } catch {
    // Not present yet
  }

  // agents.md — the per-chat local memory file (lives at the workspace root,
  // like Claude.md). Listed in the Uploaded group so the user can open/edit
  // it from the sidebar. Never deletable (it's the model's long-term memory).
  // Only surfaced when it has content (skip the empty stub).
  const agentsPath = path.join(wsDir, AGENTS_FILE_NAME);
  try {
    const stat = await fs.stat(agentsPath);
    if (stat.isFile() && stat.size > 0) {
      results.push({
        name: AGENTS_FILE_NAME,
        kind: "upload",
        size: stat.size,
        ext: ".md",
        canDeleteDirectly: false,
        downloadFormats: ["md", "pdf", "docx"] as DownloadFormat[],
      });
    }
  } catch {
    // Not present yet
  }

  // goal.md / roadmap.md live at the workspace root and are intentionally
  // excluded from this listing.

  return results;
}

// ── Internal helpers (kept private) ───────────────────────────────────────────

async function writeWorkspaceMapping(
  sessionId: string,
  workspaceId: string,
  extra?: Partial<SessionState>
): Promise<void> {
  // Write as new JSON state format
  const state: SessionState = {
    workspaceId,
    messageCount: 0,
    uploads: {},
    ...extra,
  };
  await writeSessionState(sessionId, state);
}

async function workspaceDirForSession(sessionId: string): Promise<string> {
  try {
    const state = await readSessionState(sessionId);
    return path.join(workspacesRoot(), mappedWorkspaceDirName(state.workspaceId));
  } catch {
    return workspaceDir(sessionId);
  }
}

// ── Existing public API (unchanged signatures) ─────────────────────────────────

export async function ensureWorkspace(
  sessionId: string,
  goal: Goal,
  workspaceId = sessionId,
  extra?: Partial<SessionState>
): Promise<void> {
  await provisionWorkspace(workspaceId, goal);
  await writeWorkspaceMapping(sessionId, workspaceId, extra);
}

export async function provisionWorkspace(
  workspaceId: string,
  goal: Goal
): Promise<void> {
  const ws = path.join(workspacesRoot(), mappedWorkspaceDirName(workspaceId));
  const outputDir = path.join(ws, FILES_SUBDIR);

  // Single merged folder for uploads + output.
  await fs.mkdir(outputDir, { recursive: true });

  const templateSrc = path.resolve(REPO_ROOT, goal.templatePath);
  const templateDest = path.join(outputDir, "report-template.md");

  try {
    await fs.access(templateDest);
    // Already present — skip copy
  } catch {
    try {
      await fs.copyFile(templateSrc, templateDest);
    } catch (err) {
      // Template asset may not exist yet during scaffold phase; log and continue
      console.warn(
        `[workspace] Could not copy template from ${templateSrc}: ${String(err)}`
      );
    }
  }
}

export async function saveUpload(
  sessionId: string,
  fileName: string,
  data: Uint8Array
): Promise<UploadInfo> {
  // Sanitize: strip any path separators to prevent directory traversal
  const safeName = path.basename(fileName).replace(/[/\\]/g, "_");

  const uploadsDir = path.join(await workspaceDirForSession(sessionId), FILES_SUBDIR);
  await fs.mkdir(uploadsDir, { recursive: true });

  const dest = path.join(uploadsDir, safeName);
  await atomicWriteFile(dest, data);

  return { name: safeName, size: data.byteLength };
}

/**
 * Writes extracted markdown for an uploaded source file.
 * Path: <uploads>/<sourceFileName>.md
 * Returns the relative path within the workspace.
 */
export async function writeUploadMarkdown(
  sessionId: string,
  sourceFileName: string,
  markdown: string
): Promise<string> {
  const safeName = path.basename(sourceFileName).replace(/[/\\]/g, "_");
  const uploadsDir = path.join(await workspaceDirForSession(sessionId), FILES_SUBDIR);
  await fs.mkdir(uploadsDir, { recursive: true });
  const dest = path.join(uploadsDir, `${safeName}.md`);
  await fs.writeFile(dest, markdown, "utf8");
  return path.join(FILES_SUBDIR, `${safeName}.md`);
}

/**
 * Lists source files in uploads/, excluding auto-generated *.md companions
 * whose base file also exists in the same directory.
 */
export async function listUploads(sessionId: string): Promise<UploadInfo[]> {
  const uploadsDir = path.join(await workspaceDirForSession(sessionId), FILES_SUBDIR);
  let entries: string[];
  try {
    entries = await fs.readdir(uploadsDir);
  } catch {
    return [];
  }

  const entrySet = new Set(entries);
  const results: UploadInfo[] = [];

  for (const entry of entries) {
    // Hide system files and the report (surfaced separately).
    if (entry === "report.md" || SYSTEM_FILES.has(entry)) continue;
    // Skip *.md companions: a file ending in .md whose base (without .md) also exists
    if (entry.endsWith(".md")) {
      const base = entry.slice(0, -3);
      if (entrySet.has(base)) continue;
    }
    try {
      const stat = await fs.stat(path.join(uploadsDir, entry));
      if (stat.isFile()) {
        results.push({ name: entry, size: stat.size });
      }
    } catch {
      // Skip unreadable entries
    }
  }

  return results;
}

/**
 * Reads the extracted markdown for an uploaded source file.
 * If the companion .md does not exist but the source is itself a text file,
 * reads the source directly.
 * Returns the text content and its byte length.
 */
export async function readUploadMarkdown(
  sessionId: string,
  sourceFileName: string
): Promise<{ markdown: string; bytes: number }> {
  const safeName = path.basename(sourceFileName).replace(/[/\\]/g, "_");
  const uploadsDir = path.join(await workspaceDirForSession(sessionId), FILES_SUBDIR);
  const mdPath = path.join(uploadsDir, `${safeName}.md`);

  try {
    const content = await fs.readFile(mdPath, "utf8");
    return { markdown: content, bytes: Buffer.byteLength(content, "utf8") };
  } catch {
    // Companion .md absent — try reading the source file as text
    const srcPath = path.join(uploadsDir, safeName);
    const content = await fs.readFile(srcPath, "utf8");
    return { markdown: content, bytes: Buffer.byteLength(content, "utf8") };
  }
}

/**
 * Reads the raw source text of an uploaded file (no .md sidecar preference).
 * Returns "" if the file does not exist or is not readable as UTF-8.
 * Used to capture the OLD content of a text upload BEFORE it is overwritten,
 * so a replacement diff has a correct baseline.
 */
export async function readUploadSource(
  sessionId: string,
  fileName: string
): Promise<string> {
  const safeName = path.basename(fileName).replace(/[/\\]/g, "_");
  const uploadsDir = path.join(await workspaceDirForSession(sessionId), FILES_SUBDIR);
  try {
    return await fs.readFile(path.join(uploadsDir, safeName), "utf8");
  } catch {
    return "";
  }
}

/**
 * Public wrapper around the internal unified-diff for callers that already
 * hold both the old and new text (e.g. text-file replacement, where the old
 * source must be captured before it is overwritten).
 */
export function diffTexts(
  oldText: string,
  newText: string,
  name = "file"
): string {
  return computeUnifiedDiff(`${name} (previous)`, `${name} (new)`, oldText, newText);
}

/**
 * Writes the goal body to <workspace>/goal.md (workspace root, not output/).
 */
export async function writeGoalFile(
  sessionId: string,
  goal: Goal
): Promise<void> {
  const wsDir = await workspaceDirForSession(sessionId);
  const dest = path.join(wsDir, "goal.md");
  await fs.writeFile(dest, goal.body, "utf8");
}

/**
 * Returns the absolute path to a file within the session workspace.
 * Rejects path traversal: name must be a basename with no separators.
 * Returns null if the name is unsafe.
 */
export async function resolveWorkspaceFile(
  sessionId: string,
  name: string,
  subdir?: string
): Promise<string | null> {
  const safeName = path.basename(name);
  if (safeName !== name || safeName === "" || safeName === "." || safeName === "..") {
    return null;
  }
  const wsDir = await workspaceDirForSession(sessionId);
  if (subdir) {
    return path.join(wsDir, subdir, safeName);
  }
  return path.join(wsDir, safeName);
}

// ── New helpers ────────────────────────────────────────────────────────────────

/**
 * Writes the roadmap body to <workspace>/roadmap.md (workspace root). The agent
 * maintains its checkboxes as it progresses; the app parses them for the
 * progress bar. No-op if the goal has no roadmap.
 */
export async function writeRoadmapFile(
  sessionId: string,
  roadmapText: string
): Promise<void> {
  if (!roadmapText) return;
  const wsDir = await workspaceDirForSession(sessionId);
  await fs.writeFile(path.join(wsDir, "roadmap.md"), roadmapText, "utf8");
}

/**
 * Returns the roadmap text for a session (from state first, then roadmap.md).
 */
export async function getRoadmapText(sessionId: string): Promise<string> {
  try {
    const state = await readSessionState(sessionId);
    if (state.roadmapText) return state.roadmapText;
  } catch {
    // Fall through to file read
  }
  try {
    const wsDir = await workspaceDirForSession(sessionId);
    return await fs.readFile(path.join(wsDir, "roadmap.md"), "utf8");
  } catch {
    return "";
  }
}

/**
 * Parses the session's roadmap.md into structured progress.
 * Sections are `##`/`#` headings; steps are GitHub task-list items
 * (`- [ ]` / `- [x]`). Items before any heading go under "General".
 * Returns null if there is no roadmap or it has no checklist items.
 */
export async function readRoadmapState(
  sessionId: string
): Promise<RoadmapState | null> {
  const liveText = await getRoadmapTextFromFile(sessionId);

  // Original checklist captured at session creation (the canonical item set).
  let origText = "";
  try {
    const state = await readSessionState(sessionId);
    origText = state.roadmapText ?? "";
  } catch {
    // No stored state — fall back to the live file only.
  }

  const live = liveText ? parseRoadmap(liveText) : null;
  const orig = origText ? parseRoadmap(origText) : null;

  // If the agent shrank, rewrote, or replaced the live file (fewer items than
  // the original checklist), keep the ORIGINAL structure as the canonical total
  // and mark items done by matching the labels the agent actually checked off.
  // This prevents a destructive rewrite (e.g. 56 items -> 6) from collapsing the
  // progress bar's denominator.
  if (orig && (!live || live.totalSteps < orig.totalSteps)) {
    const doneLabels = new Set<string>();
    if (live) {
      for (const s of live.sections) {
        for (const st of s.steps) {
          if (st.done) doneLabels.add(normalizeRoadmapLabel(st.label));
        }
      }
    }
    let done = 0;
    const sections: RoadmapSection[] = orig.sections.map((s) => ({
      title: s.title,
      steps: s.steps.map((st) => {
        const isDone = st.done || doneLabels.has(normalizeRoadmapLabel(st.label));
        if (isDone) done += 1;
        return { label: st.label, done: isDone };
      }),
    }));
    return {
      sections,
      totalSteps: orig.totalSteps,
      doneSteps: done,
      pct: orig.totalSteps === 0 ? 0 : Math.round((done / orig.totalSteps) * 100),
    };
  }

  return live;
}

function normalizeRoadmapLabel(label: string): string {
  return label.toLowerCase().replace(/\s+/g, " ").trim();
}

async function getRoadmapTextFromFile(sessionId: string): Promise<string> {
  try {
    const wsDir = await workspaceDirForSession(sessionId);
    return await fs.readFile(path.join(wsDir, "roadmap.md"), "utf8");
  } catch {
    return "";
  }
}

export function parseRoadmap(text: string): RoadmapState | null {
  const lines = text.split("\n");
  const sections: RoadmapSection[] = [];
  let current: RoadmapSection | null = null;
  let total = 0;
  let done = 0;

  const ensureSection = (title: string): void => {
    current = { title, steps: [] };
    sections.push(current);
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^#{1,6}\s+(.*)$/.exec(line.trim());
    if (heading) {
      ensureSection(heading[1].trim());
      continue;
    }
    const task = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (task) {
      if (!current) ensureSection("General");
      const isDone = task[1].toLowerCase() === "x";
      current!.steps.push({ label: task[2].trim(), done: isDone });
      total += 1;
      if (isDone) done += 1;
    }
  }

  // Drop empty sections (headings with no tasks)
  const nonEmpty = sections.filter((s) => s.steps.length > 0);
  if (total === 0) return null;

  return {
    sections: nonEmpty,
    totalSteps: total,
    doneSteps: done,
    pct: total === 0 ? 0 : Math.round((done / total) * 100),
  };
}

/**
 * Renders the session's LIVE roadmap as a compact markdown checklist for
 * injection into the per-turn system context. This puts the full plan in the
 * agent's context from the first turn and keeps the current done/open state
 * visible every round — so the model does not have to call `roadmap_status` to
 * discover what is left (weaker models reliably forget to). Returns "" when the
 * session has no roadmap.
 */
export async function renderRoadmapForContext(
  sessionId: string
): Promise<string> {
  const state = await readRoadmapState(sessionId);
  if (!state || state.totalSteps === 0) return "";

  const lines: string[] = [];
  lines.push(
    `## Progress roadmap — ${state.doneSteps}/${state.totalSteps} complete (${state.pct}%)`
  );
  lines.push(
    "`[x]` = data obtained, `[ ]` = still open. Mark items done the SAME turn you " +
    "get the data — call `roadmap_mark_done` with ONE array entry PER item below, " +
    "worded like the item's own text (copy its key words). If a single document " +
    "covers several items, list each one separately — do NOT lump them into one " +
    "entry describing the document. Call `roadmap_mark_undone` to re-open an item. " +
    "Do NOT edit `roadmap.md` yourself."
  );
  for (const sec of state.sections) {
    lines.push("", `### ${sec.title}`);
    for (const st of sec.steps) {
      lines.push(`- [${st.done ? "x" : " "}] ${st.label}`);
    }
  }
  return lines.join("\n");
}

// ── Deterministic roadmap progress application (BFF-owned) ───────────────────
// The MAIN agent emits a <progress> tag listing the checklist items it just
// satisfied (plain structured text — reliable even for weak local models, which
// intermittently empty-turn on tool CALLS). The BFF parses that tag and flips
// the matching checkboxes here, deterministically — no model tool-call required.
// This logic is ported from mcp/roadmap/index.mjs (the same fuzzy-matcher) so
// the canonical roadmap.md the progress bar reads is updated identically.

const ROADMAP_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "at", "by",
  "with", "from", "is", "are", "be", "this", "that", "your", "their", "its",
  "data", "info", "information", "section",
]);
const ROADMAP_TASK_RE = /^(\s*[-*]\s+\[)([ xX])(\]\s+)(.*)$/;
const ROADMAP_MATCH_THRESHOLD = 0.5;

function roadmapNormalize(label: string): string {
  return String(label)
    .toLowerCase()
    .replace(/[*_`#>]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function roadmapTokenize(label: string): string[] {
  return roadmapNormalize(label)
    .split(" ")
    .filter((t) => t.length > 0 && !ROADMAP_STOPWORDS.has(t));
}

function roadmapMatchScore(query: string, candidate: string): number {
  const nq = roadmapNormalize(query);
  const nc = roadmapNormalize(candidate);
  if (!nq || !nc) return 0;
  if (nq === nc) return 2;
  const qTokens = roadmapTokenize(query);
  const cTokens = new Set(roadmapTokenize(candidate));
  if (qTokens.length === 0) return 0;
  let shared = 0;
  for (const t of qTokens) if (cTokens.has(t)) shared += 1;
  let score = shared / qTokens.length;
  if (nc.includes(nq) || nq.includes(nc)) score += 0.5;
  return score;
}

/**
 * Parses a progress block out of an assistant reply. Two supported formats:
 *   1. <progress>done: a; b\nundone: c</progress> (legacy)
 *   2. PROGRESS: item; item; item (simple one-liner, preferred)
 * `done:`/`undone:` lines and PROGRESS items are split on `;` or `,`.
 * Returns null if no progress block is present.
 */
export function parseProgressTag(
  text: string
): { done: string[]; undone: string[] } | null {
  // Format 2: PROGRESS: item; item (simple one-liner)
  const pline = /(?:^|\n)\s*PROGRESS\s*:\s*(.+)/i.exec(text);
  if (pline) {
    const items = pline[1]
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return { done: items, undone: [] };
  }
  // Format 1: <progress> block (legacy)
  const m = /<progress>([\s\S]*?)<\/progress>/i.exec(text);
  if (!m) return null;
  const body = m[1];
  const pick = (key: string): string[] => {
    const line = new RegExp(`(?:^|\\n)\\s*${key}\\s*:\\s*(.+)`, "i").exec(body);
    if (!line) return [];
    return line[1]
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  };
  return { done: pick("done"), undone: pick("undone") };
}

/**
 * Deterministically flips roadmap.md checkboxes for the given item descriptions.
 * `doneItems` fuzzy-match against UNCHECKED items → `- [x]`; `undoneItems` match
 * CHECKED items → `- [ ]`. Atomic write. Returns the new RoadmapState (with the
 * canonical-denominator insurance from readRoadmapState), or null if no roadmap.
 */
export async function applyRoadmapProgress(
  sessionId: string,
  doneItems: string[],
  undoneItems: string[]
): Promise<RoadmapState | null> {
  if (doneItems.length === 0 && undoneItems.length === 0) {
    return readRoadmapState(sessionId);
  }
  const text = await getRoadmapTextFromFile(sessionId);
  if (!text) return readRoadmapState(sessionId);

  const lines = text.split("\n");

  const flip = (queries: string[], markDone: boolean): boolean => {
    // Candidate task lines: when marking done, match OPEN items; when un-marking, DONE.
    const candidates: { lineIdx: number; label: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const mm = ROADMAP_TASK_RE.exec(lines[i].replace(/\s+$/, ""));
      if (!mm) continue;
      const isDone = mm[2].toLowerCase() === "x";
      if (markDone ? !isDone : isDone) {
        candidates.push({ lineIdx: i, label: mm[4].trim() });
      }
    }
    const usedLineIdx = new Set<number>();
    const newChar = markDone ? "x" : " ";
    let changed = false;
    for (const query of queries) {
      if (typeof query !== "string" || query.trim() === "") continue;
      let best: { lineIdx: number; label: string } | null = null;
      let bestScore = 0;
      for (const c of candidates) {
        if (usedLineIdx.has(c.lineIdx)) continue;
        const score = roadmapMatchScore(query, c.label);
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      if (best && bestScore >= ROADMAP_MATCH_THRESHOLD) {
        usedLineIdx.add(best.lineIdx);
        const mm = ROADMAP_TASK_RE.exec(lines[best.lineIdx].replace(/\s+$/, ""));
        if (mm) {
          lines[best.lineIdx] = `${mm[1]}${newChar}${mm[3]}${mm[4]}`;
          changed = true;
        }
      }
    }
    return changed;
  };

  const c1 = flip(doneItems, true);
  const c2 = flip(undoneItems, false);

  if (c1 || c2) {
    try {
      const wsDir = await workspaceDirForSession(sessionId);
      await atomicWriteFile(path.join(wsDir, "roadmap.md"), lines.join("\n"));
    } catch (e) {
      console.debug("[workspace] applyRoadmapProgress write failed:", e);
    }
  }
  return readRoadmapState(sessionId);
}

/**
 * Returns the goal text for a session.
 * Reads from SessionState.goalText first; falls back to reading goal.md.
 */
export async function getGoalText(sessionId: string): Promise<string> {
  try {
    const state = await readSessionState(sessionId);
    if (state.goalText) return state.goalText;
  } catch {
    // Fall through to file read
  }

  try {
    const wsDir = await workspaceDirForSession(sessionId);
    return await fs.readFile(path.join(wsDir, "goal.md"), "utf8");
  } catch {
    return "";
  }
}

/**
 * Creates an empty `agents.md` stub on the workspace root if one doesn't
 * already exist. Idempotent — never overwrites a user-edited file.
 *
 * `agents.md` is the per-chat local memory file (like Claude.md): the
 * model's long-term instructions that survive compaction. It's listed in
 * the sidebar and editable via the in-app editor; the report-compaction
 * plugin re-injects it after compaction.
 */
export async function writeAgentsStub(sessionId: string): Promise<void> {
  const wsDir = await workspaceDirForSession(sessionId);
  const filePath = path.join(wsDir, AGENTS_FILE_NAME);
  try {
    await fs.stat(filePath);
    return; // already exists
  } catch {
    // missing — write stub
  }
  const stub = "";
  await fs.writeFile(filePath, stub, "utf8");
}

/**
 * Returns the per-chat AGENTS.md content (the model's long-term memory file),
 * or null if the file does not exist or is still the empty stub.
 */
export async function getAgentsText(sessionId: string): Promise<string | null> {
  const wsDir = await workspaceDirForSession(sessionId);
  const filePath = path.join(wsDir, AGENTS_FILE_NAME);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

/**
 * Returns a time-injection string if this is the first turn OR if 12+ hours
 * have elapsed since the last injection. Updates lastTimeUpdateMs in state.
 * Returns null if no injection is needed.
 */
export async function bumpTimeIfDue(sessionId: string): Promise<string | null> {
  const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

  let now: number | null;
  try {
    now = await updateSessionState(sessionId, (state) => {
      const t = Date.now();
      const lastUpdate = state.lastTimeUpdateMs;
      const isDue =
        lastUpdate === undefined || t - lastUpdate >= TWELVE_HOURS_MS;
      if (!isDue) return null;
      state.lastTimeUpdateMs = t;
      return t;
    });
  } catch {
    return null;
  }

  if (now === null) return null;

  const d = new Date(now);
  const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const weekday = weekdays[d.getUTCDay()];
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = months[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");

  return `Current date and time: ${d.toISOString()} (${weekday} ${day} ${month} ${year} ${hh}:${mm} UTC).`;
}

/**
 * Adds n bytes to the session's loadedContextBytes counter.
 */
export async function addLoadedContextBytes(
  sessionId: string,
  n: number
): Promise<void> {
  await updateSessionState(sessionId, (state) => {
    state.loadedContextBytes = (state.loadedContextBytes ?? 0) + n;
  });
}

/**
 * Records that the agent read `bytes` of content from file `pathKey` via the
 * `read` tool. Deduplicated: we keep the LARGEST read seen for a given path, so
 * repeated/partial reads of the same file don't inflate the document total.
 * Returns the new sum of all recorded read-document bytes.
 */
export async function recordReadDocBytes(
  sessionId: string,
  pathKey: string,
  bytes: number
): Promise<number> {
  return updateSessionState(sessionId, (state) => {
    const map = state.readDocBytes ?? {};
    const key = pathKey || "(unknown)";
    if (bytes > (map[key] ?? 0)) {
      map[key] = bytes;
    }
    state.readDocBytes = map;
    return Object.values(map).reduce((a, b) => a + b, 0);
  });
}

/**
 * Sum of all bytes the agent has read into context (across unique files).
 */
export function sumReadDocBytes(state: SessionState): number {
  const map = state.readDocBytes ?? {};
  return Object.values(map).reduce((a, b) => a + b, 0);
}

/**
 * Deletes a session's workspace directory AND the `.sessions/<id>` mapping
 * file. Idempotent — missing paths are ignored. Caller is responsible for
 * also calling the opencode engine's `DELETE /session/:id` so the session
 * disappears from `GET /session?roots=true`.
 */
export async function deleteSession(sessionId: string): Promise<void> {
  // Capture the workspace dir BEFORE unlinking the state file — once the state
  // file is gone, workspaceDirForSession falls back to the wrong path and the
  // real UUID workspace would never be deleted.
  const wsDir = await workspaceDirForSession(sessionId);

  // Unlink the state mapping (cheap, in .sessions/)
  try {
    await fs.unlink(path.join(mappingDir(), mappedWorkspaceDirName(sessionId)));
  } catch {
    // Missing state file is fine
  }

  // Remove the workspace dir (uploads, report, goal, roadmap, agents, etc.)
  try {
    await fs.rm(wsDir, { recursive: true, force: true });
  } catch {
    // Missing workspace dir is fine
  }

  // Remove context-manager sidecar state stored by the opencode plugin. It lives
  // outside the per-session workspace so it must be cleaned up separately.
  try {
    await fs.rm(contextManagerStatePath(sessionId), { force: true });
  } catch {
    // Missing sidecar is fine
  }
}

function contextManagerStatePath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
  return path.join(workspacesRoot(), ".context-manager", "dcp", `${safe}.json`);
}

// ── Presented deliverables ────────────────────────────────────────────────────
//
// The agent marks a file as a "presented" deliverable via the workspace MCP
// `present_file` tool, which appends the file's basename to
// `<ws>/output/.presented` (one name per line). Both the MCP server (engine
// container) and the app read/write this marker through the shared /workspaces
// volume — it is the cross-container channel since the MCP cannot see the app's
// sessionId. listEnvFiles surfaces these under the "Presented" group.

function presentedFilePath(wsDir: string): string {
  return path.join(wsDir, FILES_SUBDIR, ".presented");
}

/**
 * Reads the set of presented file basenames for a session.
 */
export async function readPresented(sessionId: string): Promise<Set<string>> {
  try {
    const wsDir = await workspaceDirForSession(sessionId);
    const raw = await fs.readFile(presentedFilePath(wsDir), "utf8");
    return new Set(
      raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
    );
  } catch {
    return new Set();
  }
}

/**
 * Marks a file as a presented deliverable (idempotent). App-side helper that
 * mirrors what the MCP `present_file` tool does.
 */
export async function markPresented(
  sessionId: string,
  fileName: string
): Promise<void> {
  const safeName = path.basename(fileName).replace(/[/\\]/g, "_");
  const current = await readPresented(sessionId);
  if (current.has(safeName)) return;
  current.add(safeName);
  const wsDir = await workspaceDirForSession(sessionId);
  await atomicWriteFile(
    presentedFilePath(wsDir),
    [...current].join("\n") + "\n",
    "utf8"
  );
}

/**
 * Replaces the stored markdown for an upload with new content.
 * Computes a unified diff between old and new markdown.
 * Overwrites the .md sidecar with the new content.
 * Returns the diff string (capped at ~8000 chars).
 */
export async function replaceUpload(
  sessionId: string,
  fileName: string,
  newMarkdown: string
): Promise<{ diff: string }> {
  const safeName = path.basename(fileName).replace(/[/\\]/g, "_");
  const uploadsDir = path.join(await workspaceDirForSession(sessionId), FILES_SUBDIR);
  const mdPath = path.join(uploadsDir, `${safeName}.md`);

  let oldMarkdown = "";
  try {
    oldMarkdown = await fs.readFile(mdPath, "utf8");
  } catch {
    // No previous sidecar — diff will show everything as added
  }

  const diff = computeUnifiedDiff(
    `${safeName}.md (previous)`,
    `${safeName}.md (new)`,
    oldMarkdown,
    newMarkdown
  );

  await fs.writeFile(mdPath, newMarkdown, "utf8");

  return { diff };
}

// ── In-app text editor (read/save agent-visible content) ──────────────────────

/**
 * Resolves the on-disk path of the AGENT-VISIBLE text for a named file, plus
 * the path that an in-app edit should write back to.
 *   - goal.md / roadmap.md     → workspace root
 *   - report.md                → output/report.md
 *   - converted upload (sidecar exists) → output/<name>.md  (what the agent reads)
 *   - text upload (no sidecar) → output/<name>              (the source itself)
 */
async function resolveEditTarget(
  sessionId: string,
  name: string
): Promise<string> {
  const safeName = path.basename(name).replace(/[/\\]/g, "_");
  const wsDir = await workspaceDirForSession(sessionId);

  // Case-insensitive comparison so Windows dev paths (e.g. "Goal.md") still
  // route correctly. The actual on-disk filename is always the canonical form.
  const safeNameLower = safeName.toLowerCase();
  if (
    safeNameLower === "goal.md" ||
    safeNameLower === "roadmap.md" ||
    safeNameLower === AGENTS_FILE_NAME.toLowerCase()
  ) {
    // Use the canonical casing for the on-disk path
    const canonical =
      safeNameLower === AGENTS_FILE_NAME.toLowerCase() ? AGENTS_FILE_NAME : safeName.toLowerCase();
    return path.join(wsDir, canonical);
  }

  const filesDir = path.join(wsDir, FILES_SUBDIR);
  if (safeName === "report.md" || safeName.endsWith(".md")) {
    return path.join(filesDir, safeName);
  }

  // For a non-.md upload, prefer its sidecar (the converted markdown the agent
  // reads); fall back to the source for plain-text uploads.
  const sidecar = path.join(filesDir, `${safeName}.md`);
  try {
    await fs.access(sidecar);
    return sidecar;
  } catch {
    return path.join(filesDir, safeName);
  }
}

/**
 * Reads the agent-visible text for a file (for the in-app editor).
 */
export async function readWorkspaceText(
  sessionId: string,
  name: string
): Promise<string> {
  const target = await resolveEditTarget(sessionId, name);
  return fs.readFile(target, "utf8");
}

/**
 * Saves edited text back to the agent-visible file and returns a unified diff
 * of the change (for notifying the agent).
 */
export async function writeWorkspaceText(
  sessionId: string,
  name: string,
  content: string
): Promise<{ diff: string }> {
  const target = await resolveEditTarget(sessionId, name);
  let oldText = "";
  try {
    oldText = await fs.readFile(target, "utf8");
  } catch {
    // New file — diff shows everything added
  }
  await atomicWriteFile(target, content, "utf8");
  const diff = diffTexts(oldText, content, path.basename(name));
  return { diff };
}

// ── Minimal LCS-based unified diff ────────────────────────────────────────────

const DIFF_CHAR_CAP = 8000;
const CONTEXT_LINES = 3;

/**
 * Computes a unified diff between two texts.
 * Uses a simple LCS on lines. Output is capped at DIFF_CHAR_CAP characters.
 */
function computeUnifiedDiff(
  fromLabel: string,
  toLabel: string,
  oldText: string,
  newText: string
): string {
  const oldLines = oldText === "" ? [] : oldText.split("\n");
  const newLines = newText === "" ? [] : newText.split("\n");

  // Build LCS table
  const m = oldLines.length;
  const n = newLines.length;

  // For large files, fall back to a simple line-by-line diff to avoid O(m*n) memory
  const MAX_LCS_CELLS = 500_000;
  let editScript: Array<{ op: "eq" | "del" | "ins"; line: string }>;

  if (m * n > MAX_LCS_CELLS) {
    // Fallback: treat all old lines as deleted, all new lines as inserted
    editScript = [
      ...oldLines.map((l) => ({ op: "del" as const, line: l })),
      ...newLines.map((l) => ({ op: "ins" as const, line: l })),
    ];
  } else {
    editScript = lcsEditScript(oldLines, newLines);
  }

  // Group into hunks with context
  const hunks = buildHunks(editScript, CONTEXT_LINES);

  const header = `--- ${fromLabel}\n+++ ${toLabel}\n`;
  let out = header;

  for (const hunk of hunks) {
    out += hunk;
    if (out.length >= DIFF_CHAR_CAP) {
      out = out.slice(0, DIFF_CHAR_CAP) + "\n... (diff truncated)\n";
      break;
    }
  }

  if (out === header) {
    out += "(no changes)\n";
  }

  return out;
}

function lcsEditScript(
  oldLines: string[],
  newLines: string[]
): Array<{ op: "eq" | "del" | "ins"; line: string }> {
  const m = oldLines.length;
  const n = newLines.length;

  // dp[i][j] = LCS length for oldLines[0..i-1], newLines[0..j-1]
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0)
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack
  const result: Array<{ op: "eq" | "del" | "ins"; line: string }> = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ op: "eq", line: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ op: "ins", line: newLines[j - 1] });
      j--;
    } else {
      result.push({ op: "del", line: oldLines[i - 1] });
      i--;
    }
  }

  result.reverse();
  return result;
}

function buildHunks(
  editScript: Array<{ op: "eq" | "del" | "ins"; line: string }>,
  context: number
): string[] {
  // Find indices of changed lines
  const changed = new Set<number>();
  for (let i = 0; i < editScript.length; i++) {
    if (editScript[i].op !== "eq") changed.add(i);
  }

  if (changed.size === 0) return [];

  // Build ranges with context
  const ranges: Array<[number, number]> = [];
  let start = -1;
  let end = -1;

  for (const idx of [...changed].sort((a, b) => a - b)) {
    const lo = Math.max(0, idx - context);
    const hi = Math.min(editScript.length - 1, idx + context);

    if (start === -1) {
      start = lo;
      end = hi;
    } else if (lo <= end + 1) {
      end = Math.max(end, hi);
    } else {
      ranges.push([start, end]);
      start = lo;
      end = hi;
    }
  }
  if (start !== -1) ranges.push([start, end]);

  // Render hunks
  const hunks: string[] = [];
  let oldLineNo = 1;
  let newLineNo = 1;
  let scriptIdx = 0;

  for (const [lo, hi] of ranges) {
    // Advance counters to lo
    while (scriptIdx < lo) {
      const op = editScript[scriptIdx].op;
      if (op === "eq" || op === "del") oldLineNo++;
      if (op === "eq" || op === "ins") newLineNo++;
      scriptIdx++;
    }

    // Count old/new lines in this hunk
    let oldCount = 0;
    let newCount = 0;
    for (let k = lo; k <= hi; k++) {
      const op = editScript[k].op;
      if (op === "eq" || op === "del") oldCount++;
      if (op === "eq" || op === "ins") newCount++;
    }

    let hunk = `@@ -${oldLineNo},${oldCount} +${newLineNo},${newCount} @@\n`;

    for (let k = lo; k <= hi; k++) {
      const { op, line } = editScript[k];
      if (op === "eq") {
        hunk += ` ${line}\n`;
        oldLineNo++;
        newLineNo++;
      } else if (op === "del") {
        hunk += `-${line}\n`;
        oldLineNo++;
      } else {
        hunk += `+${line}\n`;
        newLineNo++;
      }
      scriptIdx++;
    }

    hunks.push(hunk);
  }

  return hunks;
}
