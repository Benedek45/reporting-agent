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

interface UploadResult {
  name: string;
  size: number;
  converted: boolean;
  replaced: boolean;
  diff?: string;
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

    // Build a set of existing upload names to detect replacements
    const existingUploads = await listUploads(sessionId).catch(() => []);
    const existingNames = new Set(existingUploads.map((u) => u.name));

    const uploaded: UploadResult[] = [];

    for (const entry of fileEntries) {
      if (!(entry instanceof File)) {
        return Response.json(
          { error: "Invalid file entry" },
          { status: 400 }
        );
      }

      const safeName = entry.name.replace(/[/\\]/g, "_");
      const isReplacement = existingNames.has(safeName);
      const isText = isAlreadyText(entry.name);

      // For a TEXT replacement, capture the OLD source content BEFORE
      // saveUpload overwrites it — text files have no .md sidecar to diff
      // against, so this is the only correct baseline.
      let oldTextForDiff = "";
      if (isReplacement && isText) {
        oldTextForDiff = await readUploadSource(sessionId, safeName);
      }

      const data = new Uint8Array(await entry.arrayBuffer());
      const info = await saveUpload(sessionId, entry.name, data);

      let converted = false;
      let replaced = false;
      let diff: string | undefined;

      if (!isText) {
        try {
          const markdown = await convertToMarkdown(entry.name, data);

          if (isReplacement) {
            // Converted file: the OLD .md sidecar still exists at this point,
            // so replaceUpload reads it for the baseline, then overwrites it.
            const result = await replaceUpload(sessionId, info.name, markdown);
            diff = result.diff;
            replaced = true;
          } else {
            await writeUploadMarkdown(sessionId, entry.name, markdown);
          }
          converted = true;
        } catch (convErr) {
          console.warn(
            `[POST /api/upload] conversion failed for ${entry.name}:`,
            convErr
          );
        }
      } else if (isReplacement) {
        // Text file: the source was just overwritten with the new content
        // and the agent reads it directly (no sidecar). Diff against the
        // captured old text.
        const textContent = Buffer.from(data).toString("utf8");
        diff = diffTexts(oldTextForDiff, textContent, info.name);
        replaced = true;
      }

      await recordUpload(sessionId, info.name);

      const result: UploadResult = {
        name: info.name,
        size: info.size,
        converted,
        replaced,
      };
      if (diff !== undefined) result.diff = diff;
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
