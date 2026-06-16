export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { saveUpload, writeUploadMarkdown, recordUpload } from "@/lib/workspace";
import { convertToMarkdown, isAlreadyText } from "@/lib/converter";

interface UploadResult {
  name: string;
  size: number;
  converted: boolean;
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

    const uploaded: UploadResult[] = [];

    for (const entry of fileEntries) {
      if (!(entry instanceof File)) {
        return Response.json(
          { error: "Invalid file entry" },
          { status: 400 }
        );
      }

      const data = new Uint8Array(await entry.arrayBuffer());
      const info = await saveUpload(sessionId, entry.name, data);

      let converted = false;
      if (!isAlreadyText(entry.name)) {
        try {
          const markdown = await convertToMarkdown(entry.name, data);
          await writeUploadMarkdown(sessionId, entry.name, markdown);
          converted = true;
        } catch (convErr) {
          console.warn(
            `[POST /api/upload] conversion failed for ${entry.name}:`,
            convErr
          );
        }
      }

      await recordUpload(sessionId, info.name);
      uploaded.push({ name: info.name, size: info.size, converted });
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
