export const runtime = "nodejs";

import { NextRequest } from "next/server";
import {
  getLatestContextTokens,
  contextUsedTokens,
  getProviderContextLimit,
  getTodos,
  getSessionStatus,
} from "@/lib/opencode";
import {
  readSessionState,
  sumReadDocBytes,
  sessionDirectory,
  readRoadmapState,
} from "@/lib/workspace";
import type {
  TodoItem,
  ContextBreakdownItem,
  RoadmapState,
} from "@/types";

interface StateResponse {
  usedTokens: number;
  contextLimit: number;
  pct: number;
  todos: TodoItem[];
  status: string;
  breakdown: ContextBreakdownItem[];
  roadmap: RoadmapState | null;
}

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
    const [tokensDetail, contextLimit, todos, status] = await Promise.all([
      getLatestContextTokens(sessionId, directory),
      getProviderContextLimit(),
      getTodos(sessionId).catch((): TodoItem[] => []),
      getSessionStatus(sessionId).catch(() => "idle"),
    ]);

    // True current context-window occupancy from the latest turn
    // (NOT the engine's cumulative lifetime sum).
    const usedTokens = contextUsedTokens(tokensDetail);

    const pct = Math.min(100, Math.round((usedTokens / contextLimit) * 100));

    // Build approximate breakdown
    const reasoningTokens = tokensDetail.reasoning ?? 0;
    const state = await readSessionState(sessionId).catch(() => ({
      workspaceId: sessionId,
      messageCount: 0,
      uploads: {} as Record<string, number>,
      loadedContextBytes: 0,
    }));
    // Documents = files loaded via the button + files the agent read itself
    const documentBytes =
      (state.loadedContextBytes ?? 0) + sumReadDocBytes(state);
    const documentTokens = Math.ceil(documentBytes / 4);
    const systemBaseline = 6000; // approximate constant
    const conversationTokens = Math.max(
      0,
      usedTokens - reasoningTokens - documentTokens - systemBaseline
    );

    const breakdown: ContextBreakdownItem[] = [
      { label: "Reasoning", tokens: reasoningTokens },
      { label: "Documents", tokens: documentTokens },
      { label: "System & tools (approx.)", tokens: systemBaseline },
      { label: "Conversation", tokens: conversationTokens },
    ];

    const roadmap = await readRoadmapState(sessionId).catch(() => null);

    const response: StateResponse = {
      usedTokens,
      contextLimit,
      pct,
      todos,
      status,
      breakdown,
      roadmap,
    };

    return Response.json(response);
  } catch (err) {
    console.error(`[GET /api/session/${sessionId}/state]`, err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
