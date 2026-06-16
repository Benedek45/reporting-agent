export const runtime = "nodejs";

import { NextRequest } from "next/server";
import {
  getSessionTokens,
  getProviderContextLimit,
  getTodos,
  getSessionStatus,
} from "@/lib/opencode";
import type { TodoItem } from "@/types";

interface StateResponse {
  usedTokens: number;
  contextLimit: number;
  pct: number;
  todos: TodoItem[];
  status: string;
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
    const [usedTokens, contextLimit, todos, status] = await Promise.all([
      getSessionTokens(sessionId),
      getProviderContextLimit(),
      getTodos(sessionId).catch((): TodoItem[] => []),
      getSessionStatus(sessionId).catch(() => "idle"),
    ]);

    const pct = Math.min(100, Math.round((usedTokens / contextLimit) * 100));

    const response: StateResponse = {
      usedTokens,
      contextLimit,
      pct,
      todos,
      status,
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
