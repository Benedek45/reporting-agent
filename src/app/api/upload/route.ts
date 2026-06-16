export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { saveUpload } from "@/lib/workspace";
import type { UploadInfo } from "@/types";

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

    const uploaded: UploadInfo[] = [];

    for (const entry of fileEntries) {
      if (!(entry instanceof File)) {
        return Response.json(
          { error: "Invalid file entry" },
          { status: 400 }
        );
      }

      const data = new Uint8Array(await entry.arrayBuffer());
      const info = await saveUpload(sessionId, entry.name, data);
      uploaded.push(info);
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
