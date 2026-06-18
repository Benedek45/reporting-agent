export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { readUploadMarkdown, addLoadedContextBytes, isSafeName } from "@/lib/workspace";
import { sendMessage } from "@/lib/opencode";

// Minimal workspace guidance injected on the legacy non-streaming path so the
// agent is aware of the merged folder layout and deliverable conventions.
// (The full WORKSPACE_GUIDANCE constant lives in /api/chat/stream/route.ts;
// this is a compact version for the synchronous sendMessage path.)
const WORKSPACE_GUIDANCE =
  "All files (uploads and the report) live in one folder. " +
  "Continue writing the report to `output/report.md`. " +
  "If you produce any other deliverable, call `present_file` with its absolute path.";

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

    // Reject path-traversal / prompt-injection: fileName must be a safe basename.
    if (!isSafeName(fileName)) {
      return Response.json({ error: "Invalid file name" }, { status: 400 });
    }

    const MAX = Number(process.env.MAX_CONTEXT_FILE_BYTES ?? 200000);

    const { markdown, bytes } = await readUploadMarkdown(sessionId, fileName);

    if (bytes > MAX) {
      return Response.json(
        { error: "file too large to load fully", bytes, max: MAX },
        { status: 413 }
      );
    }

    // Track bytes loaded via the button so the context meter's Documents bucket
    // counts them (mirrors what /api/chat/stream does for the streaming path).
    await addLoadedContextBytes(sessionId, bytes);

    const result = await sendMessage(
      sessionId,
      `The user has loaded the full content of "${fileName}" as a source document. Use it as needed:\n\n---\n${markdown}\n---`,
      { system: WORKSPACE_GUIDANCE }
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
