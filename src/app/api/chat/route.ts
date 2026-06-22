export const runtime = "nodejs";

// TODO(scaffold): stream via SSE instead of awaiting full reply.
// Replace this handler with a streaming response using ReadableStream /
// TransformStream, consuming GET /event from the opencode server and
// forwarding token chunks to the client.

import { NextRequest } from "next/server";
import { sendMessage } from "@/lib/opencode";
import {
  sessionDirectory,
  renderRoadmapForContext,
} from "@/lib/workspace";

// Minimal workspace guidance injected on the legacy non-streaming path so the
// agent is aware of the merged folder layout and deliverable conventions.
function workspaceGuidance(directory: string): string {
  return (
    "Uploads and the report live in the `output/` folder; write the report to " +
    "`output/report.md`. To record progress on the user's checklist, call the " +
    "`roadmap_mark_done` tool with `workspace_dir` = `" +
    directory +
    "` and `items` = short descriptions of the completed checklist items (it " +
    "fuzzy-matches and flips the right checkboxes). Do NOT edit `roadmap.md` " +
    "yourself and never create `output/roadmap.md`. If you produce any other " +
    "deliverable, call `present_file` with its absolute path."
  );
}

const VISIBLE_REPLY_GUARD =
  "## Output format — wrap your visible reply in <reply>...</reply>\n" +
  "Do any internal planning, file-reading notes, tool reasoning, or self-instructions FIRST " +
  "(or keep them in your reasoning channel). Then write the message the user should see, wrapped " +
  "in <reply> and </reply> tags. ONLY the text inside <reply>...</reply> is shown to the user; " +
  "everything outside the tags is discarded. Always include BOTH tags, even for a one-line reply. " +
  "Never put planning such as `The skill is loaded`, `Now I need to`, `I will combine`, " +
  "`The user uploaded`, `There is no .md version`, or a `Plan:` section inside the <reply> tags.";

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

    const directory = await sessionDirectory(sessionId);
    const roadmapContext = await renderRoadmapForContext(sessionId);

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
