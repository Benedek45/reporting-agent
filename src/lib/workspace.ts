// server-only

import fs from "node:fs/promises";
import path from "node:path";
import type { Goal, UploadInfo } from "@/types";

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

function mappingDir(): string {
  return path.join(workspacesRoot(), ".sessions");
}

function mappedWorkspaceDirName(sessionId: string): string {
  return path.basename(sessionId).replace(/[/\\]/g, "_");
}

async function writeWorkspaceMapping(
  sessionId: string,
  workspaceId: string
): Promise<void> {
  await fs.mkdir(mappingDir(), { recursive: true });
  await fs.writeFile(
    path.join(mappingDir(), mappedWorkspaceDirName(sessionId)),
    workspaceId,
    "utf8"
  );
}

async function workspaceDirForSession(sessionId: string): Promise<string> {
  try {
    const workspaceId = await fs.readFile(
      path.join(mappingDir(), mappedWorkspaceDirName(sessionId)),
      "utf8"
    );
    return path.join(workspacesRoot(), mappedWorkspaceDirName(workspaceId.trim()));
  } catch {
    return workspaceDir(sessionId);
  }
}

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
