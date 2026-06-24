export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextRequest } from "next/server";
import {
  getLatestContextTokens,
  contextUsedTokens,
  computeContextBreakdown,
  getProviderContextLimit,
  getTodos,
  getSessionStatus,
} from "@/lib/opencode";
import {
  applyPendingCompressionSavings,
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

    const state = await readSessionState(sessionId).catch(() => ({
      workspaceId: sessionId,
      messageCount: 0,
      uploads: {} as Record<string, number>,
      loadedContextBytes: 0,
    }));
    // True current context-window occupancy from the latest turn
    // (NOT the engine's cumulative lifetime sum). If a manual `compress` tool
    // ran during that latest turn, the saved tokens apply to the NEXT request;
    // subtract them here so the UI immediately shows the projected lower usage.
    const usedTokens = applyPendingCompressionSavings(
      contextUsedTokens(tokensDetail),
      tokensDetail.createdMs,
      state
    );

    const pct = Math.min(100, Math.round((usedTokens / contextLimit) * 100));

    // Build approximate breakdown (clamped to the real total — see
    // computeContextBreakdown; prevents stale cumulative Documents counter from
    // exceeding usedTokens after the context-manager compresses).
    const reasoningTokens = tokensDetail.reasoning ?? 0;
    // Documents = files loaded via the button + files the agent read itself
    const documentBytes =
      (state.loadedContextBytes ?? 0) + sumReadDocBytes(state);

    const breakdown = computeContextBreakdown(
      usedTokens,
      reasoningTokens,
      documentBytes
    );

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

    return Response.json(response, {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
    });
  } catch (err) {
    console.error(`[GET /api/session/${sessionId}/state]`, err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
