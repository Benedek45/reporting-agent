export const runtime = "nodejs";

import { NextRequest } from "next/server";
import {
  getSessionTokensDetail,
  getProviderContextLimit,
  getTodos,
  getSessionStatus,
} from "@/lib/opencode";
import { readSessionState } from "@/lib/workspace";
import type { TodoItem, ContextBreakdownItem } from "@/types";

interface StateResponse {
  usedTokens: number;
  contextLimit: number;
  pct: number;
  todos: TodoItem[];
  status: string;
  breakdown: ContextBreakdownItem[];
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
    const [tokensDetail, contextLimit, todos, status] = await Promise.all([
      getSessionTokensDetail(sessionId),
      getProviderContextLimit(),
      getTodos(sessionId).catch((): TodoItem[] => []),
      getSessionStatus(sessionId).catch(() => "idle"),
    ]);

    const usedTokens =
      (tokensDetail.input ?? 0) +
      (tokensDetail.output ?? 0) +
      (tokensDetail.cache?.read ?? 0) +
      (tokensDetail.cache?.write ?? 0);

    const pct = Math.min(100, Math.round((usedTokens / contextLimit) * 100));

    // Build approximate breakdown
    const reasoningTokens = tokensDetail.reasoning ?? 0;
    const state = await readSessionState(sessionId).catch(() => ({
      workspaceId: sessionId,
      messageCount: 0,
      uploads: {} as Record<string, number>,
      loadedContextBytes: 0,
    }));
    const documentTokens = Math.ceil((state.loadedContextBytes ?? 0) / 4);
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

    const response: StateResponse = {
      usedTokens,
      contextLimit,
      pct,
      todos,
      status,
      breakdown,
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
