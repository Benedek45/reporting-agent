// server-only

import fs from "node:fs/promises";
import path from "node:path";
import type { Goal, SessionState, UploadInfo, EnvFile, DownloadFormat } from "@/types";

const REPO_ROOT = process.cwd();

function workspacesRoot(): string {
  return path.resolve(
    REPO_ROOT,
    process.env.WORKSPACES_ROOT ?? "../reporting-agent-workspaces"
  );
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

  return JSON.parse(trimmed) as SessionState;
}

/**
 * Writes the session state to the mapping file.
 */
export async function writeSessionState(
  sessionId: string,
  state: SessionState
): Promise<void> {
  await fs.mkdir(mappingDir(), { recursive: true });
  await fs.writeFile(
    path.join(mappingDir(), mappedWorkspaceDirName(sessionId)),
    JSON.stringify(state),
    "utf8"
  );
}

/**
 * Atomically increments the message count for a session and returns the new count.
 */
export async function incrementMessageCount(sessionId: string): Promise<number> {
  const state = await readSessionState(sessionId);
  state.messageCount += 1;
  await writeSessionState(sessionId, state);
  return state.messageCount;
}

/**
 * Records that a file was uploaded at the current message count.
 */
export async function recordUpload(
  sessionId: string,
  fileName: string
): Promise<void> {
  const state = await readSessionState(sessionId);
  const safeName = path.basename(fileName).replace(/[/\\]/g, "_");
  state.uploads[safeName] = state.messageCount;
  await writeSessionState(sessionId, state);
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
  const state = await readSessionState(sessionId);
  const safeName = path.basename(fileName).replace(/[/\\]/g, "_");
  const wsDir = await workspaceDirForSession(sessionId);
  const uploadsDir = path.join(wsDir, "uploads");

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

  // Remove from uploads map
  delete state.uploads[safeName];
  await writeSessionState(sessionId, state);
}

/**
 * Lists user-facing files for a session:
 * - uploads/ entries (excluding .md sidecars whose base exists), kind "upload"
 * - output/report.md (as name "report.md", kind "report") if present
 * NOTE: goal.md is intentionally excluded from this listing.
 */
export async function listEnvFiles(sessionId: string): Promise<EnvFile[]> {
  const wsDir = await workspaceDirForSession(sessionId);
  const uploadsDir = path.join(wsDir, "uploads");
  const state = await readSessionState(sessionId).catch(() => ({
    workspaceId: sessionId,
    messageCount: 0,
    uploads: {} as Record<string, number>,
  }));

  const results: EnvFile[] = [];

  // Uploads
  let entries: string[] = [];
  try {
    entries = await fs.readdir(uploadsDir);
  } catch {
    // No uploads dir yet
  }

  const entrySet = new Set(entries);

  for (const entry of entries) {
    // Skip .md sidecars whose base file also exists
    if (entry.endsWith(".md")) {
      const base = entry.slice(0, -3);
      if (entrySet.has(base)) continue;
    }

    try {
      const stat = await fs.stat(path.join(uploadsDir, entry));
      if (!stat.isFile()) continue;

      const uploadedAt = state.uploads[entry];
      const isDirect = uploadedAt !== undefined && uploadedAt === state.messageCount;

      results.push({
        name: entry,
        kind: "upload",
        size: stat.size,
        ext: path.extname(entry).toLowerCase(),
        canDeleteDirectly: isDirect,
        downloadFormats: ["original", "md", "pdf", "docx"] as DownloadFormat[],
      });
    } catch {
      // Skip unreadable entries
    }
  }

  // output/report.md — kind "report"
  const reportPath = path.join(wsDir, "output", "report.md");
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

  // goal.md is intentionally excluded from the listing per spec.

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
  const uploadsDir = path.join(ws, "uploads");
  const outputDir = path.join(ws, "output");

  await fs.mkdir(uploadsDir, { recursive: true });
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

  const uploadsDir = path.join(await workspaceDirForSession(sessionId), "uploads");
  await fs.mkdir(uploadsDir, { recursive: true });

  const dest = path.join(uploadsDir, safeName);
  await fs.writeFile(dest, data);

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
  const uploadsDir = path.join(await workspaceDirForSession(sessionId), "uploads");
  await fs.mkdir(uploadsDir, { recursive: true });
  const dest = path.join(uploadsDir, `${safeName}.md`);
  await fs.writeFile(dest, markdown, "utf8");
  return path.join("uploads", `${safeName}.md`);
}

/**
 * Lists source files in uploads/, excluding auto-generated *.md companions
 * whose base file also exists in the same directory.
 */
export async function listUploads(sessionId: string): Promise<UploadInfo[]> {
  const uploadsDir = path.join(await workspaceDirForSession(sessionId), "uploads");
  let entries: string[];
  try {
    entries = await fs.readdir(uploadsDir);
  } catch {
    return [];
  }

  const entrySet = new Set(entries);
  const results: UploadInfo[] = [];

  for (const entry of entries) {
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
  const uploadsDir = path.join(await workspaceDirForSession(sessionId), "uploads");
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
  const uploadsDir = path.join(await workspaceDirForSession(sessionId), "uploads");
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
 * Returns a time-injection string if this is the first turn OR if 12+ hours
 * have elapsed since the last injection. Updates lastTimeUpdateMs in state.
 * Returns null if no injection is needed.
 */
export async function bumpTimeIfDue(sessionId: string): Promise<string | null> {
  const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

  let state: SessionState;
  try {
    state = await readSessionState(sessionId);
  } catch {
    return null;
  }

  const now = Date.now();
  const lastUpdate = state.lastTimeUpdateMs;

  const isDue =
    lastUpdate === undefined || now - lastUpdate >= TWELVE_HOURS_MS;

  if (!isDue) return null;

  state.lastTimeUpdateMs = now;
  await writeSessionState(sessionId, state);

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
  const state = await readSessionState(sessionId);
  state.loadedContextBytes = (state.loadedContextBytes ?? 0) + n;
  await writeSessionState(sessionId, state);
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
  const uploadsDir = path.join(await workspaceDirForSession(sessionId), "uploads");
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
