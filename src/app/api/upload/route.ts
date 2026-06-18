export const runtime = "nodejs";

import { NextRequest } from "next/server";
import {
  saveUpload,
  writeUploadMarkdown,
  recordUpload,
  replaceUpload,
  readUploadSource,
  diffTexts,
  listUploads,
} from "@/lib/workspace";
import { convertToMarkdown, isAlreadyText } from "@/lib/converter";

/**
 * Per-file upload result shape.
 * - `tooLargeForFullContext`: true when the agent-visible markdown exceeds
 *   MAX_CONTEXT_FILE_BYTES (default 200 000 bytes). The frontend should show a
 *   notice that the file is available in the workspace but cannot be loaded
 *   fully into context via the "Load" button.
 * - `bytes`: byte length of the agent-visible markdown (sidecar for converted
 *   files, source for plain-text files).
 */
interface UploadResult {
  name: string;
  size: number;
  converted: boolean;
  replaced: boolean;
  diff?: string;
  tooLargeForFullContext?: boolean;
  bytes?: number;
}

type DupMode = "replace" | "keepboth";

/**
 * Generates a non-colliding name like "report (2).pdf" given a set of taken names.
 */
function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let i = 2;
  let candidate = `${base} (${i})${ext}`;
  while (taken.has(candidate)) {
    i += 1;
    candidate = `${base} (${i})${ext}`;
  }
  return candidate;
}

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const formData = await req.formData();

    const sessionId = formData.get("sessionId");
    if (!sessionId || typeof sessionId !== "string") {
      return Response.json(
        { error: "sessionId is required" },
        { status: 400 }
      );
    }

    const fileEntries = formData.getAll("files");
    if (fileEntries.length === 0) {
      return Response.json(
        { error: "At least one file is required" },
        { status: 400 }
      );
    }

    // Per-file duplicate-resolution modes (from the client's prompt):
    //   { "<filename>": "replace" | "keepboth" }. Files not listed and not
    //   colliding are treated as brand-new uploads. ("skip" is handled
    //   client-side by simply not sending the file.)
    let modes: Record<string, DupMode> = {};
    const modesRaw = formData.get("modes");
    if (typeof modesRaw === "string" && modesRaw) {
      try {
        modes = JSON.parse(modesRaw) as Record<string, DupMode>;
      } catch {
        // Ignore malformed modes — treat all as default
      }
    }

    // Build a set of existing upload names to detect replacements
    const existingUploads = await listUploads(sessionId).catch(() => []);
    const existingNames = new Set(existingUploads.map((u) => u.name));
    // Track names taken during THIS batch so keep-both renames don't collide.
    const takenNames = new Set(existingNames);

    const uploaded: UploadResult[] = [];

    for (const entry of fileEntries) {
      if (!(entry instanceof File)) {
        return Response.json(
          { error: "Invalid file entry" },
          { status: 400 }
        );
      }

      const requestedName = entry.name.replace(/[/\\]/g, "_");
      const collides = existingNames.has(requestedName);
      const mode = modes[requestedName];

      // Resolve the final on-disk name. "keepboth" → rename; otherwise replace
      // in place (for collisions) or use the name as-is (for new files).
      let safeName = requestedName;
      if (collides && mode === "keepboth") {
        safeName = uniqueName(requestedName, takenNames);
      }
      takenNames.add(safeName);

      const isReplacement = collides && mode !== "keepboth";
      const isText = isAlreadyText(safeName);

      // For a TEXT replacement, capture the OLD source content BEFORE
      // saveUpload overwrites it — text files have no .md sidecar to diff
      // against, so this is the only correct baseline.
      let oldTextForDiff = "";
      if (isReplacement && isText) {
        oldTextForDiff = await readUploadSource(sessionId, safeName);
      }

      const MAX_CONTEXT_FILE_BYTES = Number(
        process.env.MAX_CONTEXT_FILE_BYTES ?? 200_000
      );

      const data = new Uint8Array(await entry.arrayBuffer());
      const info = await saveUpload(sessionId, safeName, data);

      let converted = false;
      let replaced = false;
      let diff: string | undefined;
      // Byte length of the agent-visible markdown (for the tooLargeForFullContext flag).
      let mdBytes: number | undefined;

      if (!isText) {
        try {
          const markdown = await convertToMarkdown(safeName, data);
          mdBytes = Buffer.byteLength(markdown, "utf8");

          if (isReplacement) {
            // Converted file: the OLD .md sidecar still exists at this point,
            // so replaceUpload reads it for the baseline, then overwrites it.
            const result = await replaceUpload(sessionId, info.name, markdown);
            diff = result.diff;
            replaced = true;
          } else {
            await writeUploadMarkdown(sessionId, safeName, markdown);
          }
          converted = true;
        } catch (convErr) {
          console.warn(
            `[POST /api/upload] conversion failed for ${safeName}:`,
            convErr
          );
        }
      } else if (isReplacement) {
        // Text file: the source was just overwritten with the new content
        // and the agent reads it directly (no sidecar). Diff against the
        // captured old text.
        const textContent = Buffer.from(data).toString("utf8");
        mdBytes = Buffer.byteLength(textContent, "utf8");
        diff = diffTexts(oldTextForDiff, textContent, info.name);
        replaced = true;
      } else {
        // New plain-text file — agent reads the source directly.
        mdBytes = data.byteLength;
      }

      await recordUpload(sessionId, info.name);

      const result: UploadResult = {
        name: info.name,
        size: info.size,
        converted,
        replaced,
      };
      if (diff !== undefined) result.diff = diff;
      if (mdBytes !== undefined) {
        result.bytes = mdBytes;
        result.tooLargeForFullContext = mdBytes > MAX_CONTEXT_FILE_BYTES;
      }
      uploaded.push(result);
    }

    return Response.json({ uploaded });
  } catch (err) {
    console.error("[POST /api/upload]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
