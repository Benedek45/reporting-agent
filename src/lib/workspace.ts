// server-only

import fs from "node:fs/promises";
import path from "node:path";
import type { Task, UploadInfo } from "@/types";

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

export async function ensureWorkspace(
  sessionId: string,
  task: Task
): Promise<void> {
  const ws = workspaceDir(sessionId);
  const uploadsDir = path.join(ws, "uploads");
  const outputDir = path.join(ws, "output");

  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });

  const templateSrc = path.resolve(REPO_ROOT, task.templatePath);
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

  const uploadsDir = path.join(workspaceDir(sessionId), "uploads");
  await fs.mkdir(uploadsDir, { recursive: true });

  const dest = path.join(uploadsDir, safeName);
  await fs.writeFile(dest, data);

  return { name: safeName, size: data.byteLength };
}
