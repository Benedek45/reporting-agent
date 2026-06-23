export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { sessionDirectory } from "@/lib/workspace";

const ENGINE_URL = process.env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4096";

interface EngineMessage {
  info: { role: string; time: { created: number; completed?: number } };
}

/**
 * GET /api/session/:sessionId/live
 * Lightweight heartbeat: returns whether the engine is still busy generating
 * on this session. Used for SSE-reconnection polling on page load.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
): Promise<Response> {
  const { sessionId } = await params;
  if (!sessionId) {
    return Response.json({ error: "sessionId is required" }, { status: 400 });
  }

  try {
    const directory = await sessionDirectory(sessionId);

    // Fetch raw session status from the engine — the session/status map
    // returns {type:"busy"|"idle"} for active sessions.
    const statusRes = await fetch(`${ENGINE_URL}/session/status`);
    if (!statusRes.ok) throw new Error(`Engine status ${statusRes.status}`);
    const statusMap = (await statusRes.json()) as Record<string, { type: string }>;
    const status = statusMap[sessionId];
    const busy = status?.type === "busy";

    // Also check the last assistant message — if it has a completed timestamp
    // the turn has finished, regardless of what the status map says.
    const msgUrl = `${ENGINE_URL}/session/${encodeURIComponent(sessionId)}/message?directory=${encodeURIComponent(directory)}`;
    const msgRes = await fetch(msgUrl);
    if (!msgRes.ok) throw new Error(`Engine messages ${msgRes.status}`);
    const entries = (await msgRes.json()) as EngineMessage[];

    let lastAssistantRunning = false;
    if (entries && entries.length > 0) {
      const last = entries[entries.length - 1];
      if (last.info.role === "assistant" && !last.info.time?.completed) {
        lastAssistantRunning = true;
      }
    }

    return Response.json({ busy: busy || lastAssistantRunning });
  } catch (err) {
    console.error(`[GET /api/session/${sessionId}/live]`, err);
    return Response.json({ busy: false, error: "Internal" }, { status: 500 });
  }
}
