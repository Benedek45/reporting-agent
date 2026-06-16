export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { readUploadMarkdown } from "@/lib/workspace";
import { sendMessage } from "@/lib/opencode";

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const body = (await req.json()) as {
      sessionId?: string;
      fileName?: string;
    };

    const { sessionId, fileName } = body;

    if (!sessionId || !fileName) {
      return Response.json(
        { error: "sessionId and fileName are required" },
        { status: 400 }
      );
    }

    const MAX = Number(process.env.MAX_CONTEXT_FILE_BYTES ?? 200000);

    const { markdown, bytes } = await readUploadMarkdown(sessionId, fileName);

    if (bytes > MAX) {
      return Response.json(
        { error: "file too large to load fully", bytes, max: MAX },
        { status: 413 }
      );
    }

    const result = await sendMessage(
      sessionId,
      `The user has loaded the full content of "${fileName}" as a source document. Use it as needed:\n\n---\n${markdown}\n---`
    );

    return Response.json({ reply: result.text, loadedBytes: bytes });
  } catch (err) {
    console.error("[POST /api/context]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
