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
 * - uploads/ entries (excluding .md sidecars whose base exists)
 * - output/report.md (as name "report.md", kind "report") if present
 * - goal.md (kind "goal") if present
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

  // output/report.md
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

  // goal.md
  const goalPath = path.join(wsDir, "goal.md");
  try {
    const stat = await fs.stat(goalPath);
    if (stat.isFile()) {
      results.push({
        name: "goal.md",
        kind: "goal",
        size: stat.size,
        ext: ".md",
        canDeleteDirectly: false,
        downloadFormats: ["md", "pdf", "docx"] as DownloadFormat[],
      });
    }
  } catch {
    // Not present yet
  }

  return results;
}

// ── Internal helpers (kept private) ───────────────────────────────────────────

async function writeWorkspaceMapping(
  sessionId: string,
  workspaceId: string
): Promise<void> {
  // Write as new JSON state format
  const state: SessionState = { workspaceId, messageCount: 0, uploads: {} };
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
  workspaceId = sessionId
): Promise<void> {
  await provisionWorkspace(workspaceId, goal);
  await writeWorkspaceMapping(sessionId, workspaceId);
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
