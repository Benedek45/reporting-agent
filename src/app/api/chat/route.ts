export const runtime = "nodejs";

// TODO(scaffold): stream via SSE instead of awaiting full reply.
// Replace this handler with a streaming response using ReadableStream /
// TransformStream, consuming GET /event from the opencode server and
// forwarding token chunks to the client.

import { NextRequest } from "next/server";
import { sendMessage } from "@/lib/opencode";
import { renderRoadmapForContext, sessionDirectory } from "@/lib/workspace";

function workspaceGuidance(directory: string): string {
  return (
    "Uploads and the report live in the `output/` folder; write the report to " +
    "`output/report.md`. Call `roadmap_mark_done` to mark checklist items done " +
    "(workspace_dir=`" +
    directory +
    "`, items = short descriptions). Mark items the SAME turn you get the data. " +
    "Call `roadmap_mark_undone` to re-open. Do NOT edit `roadmap.md`. " +
    "If you produce any other deliverable, call `present_file`."
  );
}

const VISIBLE_REPLY_GUARD =
  "## Output format\n" +
  "Wrap your visible reply in <reply>...</reply>. Put your answer between the tags.\n" +
  "<reply>\n" +
  "Thanks for the details. Entity name and fiscal year noted.\n" +
  "</reply>\n" +
  "Never put planning inside <reply> tags.";

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const body = (await req.json()) as {
      sessionId?: string;
      text?: string;
    };

    const { sessionId, text } = body;

    if (!sessionId || !text) {
      return Response.json(
        { error: "sessionId and text are required" },
        { status: 400 }
      );
    }

    const roadmapContext = await renderRoadmapForContext(sessionId);
    const directory = await sessionDirectory(sessionId);

    const system = [
      workspaceGuidance(directory),
      roadmapContext,
      VISIBLE_REPLY_GUARD,
    ]
      .filter(Boolean)
      .join("\n\n");

    const { text: reply } = await sendMessage(sessionId, text, { system });

    return Response.json({ reply });
  } catch (err) {
    console.error("[POST /api/chat]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
