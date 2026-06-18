// server-only

import type { MessageHistoryItem } from "@/types";

const BASE_URL =
  process.env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4096";

const DEFAULT_AGENT = "compliance";
const DEFAULT_MODEL = "opencode-go/deepseek-v4-flash";

interface OpenCodePart {
  type: string;
  text?: string;
  id?: string;
  tool?: string;
  callID?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: string;
    error?: string;
    title?: string;
  };
}

interface OpenCodeMessageInfo {
  id: string;
  role: "user" | "assistant";
  time: {
    created: number;
  };
  // Present on assistant messages: the per-message token usage for THAT turn.
  // Unlike the session-level `tokens` (a cumulative lifetime sum), this is the
  // true context-window occupancy of the latest turn and carries a `total`.
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
}

interface OpenCodeMessageResponse {
  info: unknown;
  parts: OpenCodePart[];
}

interface OpenCodeHistoryEntry {
  info: OpenCodeMessageInfo;
  parts: OpenCodePart[];
}

interface OpenCodeSession {
  id: string;
  [key: string]: unknown;
}

interface OpenCodeModel {
  providerID: string;
  modelID: string;
}

export interface OpenCodeTokensDetail {
  input: number;
  output: number;
  reasoning: number;
  cache: {
    read: number;
    write: number;
  };
}

interface OpenCodeSessionDetail {
  tokens: OpenCodeTokensDetail;
  [key: string]: unknown;
}

interface OpenCodeTodo {
  content: string;
  status: string;
  priority: string;
}

interface OpenCodeProviderModel {
  limit: {
    context: number;
    output?: number;
    input?: number;
  };
}

interface OpenCodeProvider {
  id: string;
  models: Record<string, OpenCodeProviderModel>;
}

interface OpenCodeProviderList {
  all: OpenCodeProvider[];
}

interface OpenCodeSessionStatusMap {
  [sessionId: string]: { type: "idle" | "busy" | string };
}

// In-module cache for the provider context limit.
// NOTE: This is a process-lifetime cache — it is populated on the first call
// and never invalidated. If the provider's context limit changes (e.g. after a
// model update), the app must be restarted to pick up the new value.
let _cachedContextLimit: number | null = null;

async function request<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable body)");
    throw new Error(
      `OpenCode API error ${res.status} ${res.statusText} at ${path}: ${body}`
    );
  }

  return res.json() as Promise<T>;
}

function withDirectory(path: string, directory?: string): string {
  if (!directory) {
    return path;
  }

  const params = new URLSearchParams({ directory });
  return `${path}?${params.toString()}`;
}

function modelFromId(model: string): OpenCodeModel {
  const separator = model.indexOf("/");
  if (separator === -1) {
    console.warn(
      `[opencode] modelFromId: model string "${model}" has no "/" separator — ` +
        `providerID will be empty, which will likely cause an API error. ` +
        `Expected format: "providerID/modelID" (e.g. "opencode-go/deepseek-v4-flash").`
    );
    return { providerID: "", modelID: model };
  }

  return {
    providerID: model.slice(0, separator),
    modelID: model.slice(separator + 1),
  };
}

export async function createSession(
  title: string,
  directory?: string
): Promise<{ id: string }> {
  const session = await request<OpenCodeSession>(
    withDirectory("/session", directory),
    {
      method: "POST",
      body: JSON.stringify({ title }),
    }
  );
  return { id: session.id };
}

/**
 * Minimal shape of the opencode session list response — only the fields the
 * BFF exposes to the home page. The engine's full `Session.Info` includes
 * tokens, summary, etc. that we don't surface here.
 */
export interface OpenCodeSessionListItem {
  id: string;
  title?: string;
  directory?: string;
  time: { created: number; updated?: number };
}

/**
 * Lists ALL opencode sessions across the engine, sorted by most recently
 * updated. `?roots=true` includes sessions for which the engine has no
 * project root registered (i.e. sessions created against an explicit
 * `?directory=` — our case, since every chat workspace is bound to
 * `/workspaces/<uuid>` at createSession time).
 */
export async function listSessions(): Promise<OpenCodeSessionListItem[]> {
  return request<OpenCodeSessionListItem[]>("/session?roots=true&limit=200");
}

/**
 * Deletes a session in the opencode engine (removes it from the engine's DB
 * so it no longer appears in `GET /session`). Does NOT touch the workspace
 * filesystem — the BFF handles that separately.
 */
export async function deleteSession(sessionId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/session/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    const errBody = await res.text().catch(() => "(unreadable body)");
    throw new Error(
      `OpenCode delete session error ${res.status} ${res.statusText}: ${errBody}`
    );
  }
}

export async function sendMessage(
  sessionId: string,
  text: string,
  opts?: { agent?: string; model?: string; directory?: string; system?: string }
): Promise<{ text: string }> {
  const body: Record<string, unknown> = {
    model: modelFromId(opts?.model ?? DEFAULT_MODEL),
    agent: opts?.agent ?? DEFAULT_AGENT,
    parts: [{ type: "text", text }],
  };

  if (opts?.system) {
    body["system"] = opts.system;
  }

  const response = await request<OpenCodeMessageResponse>(
    withDirectory(`/session/${sessionId}/message`, opts?.directory),
    {
      method: "POST",
      body: JSON.stringify(body),
    }
  );

  const combined = response.parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");

  return { text: combined };
}

/**
 * Fire-and-forget async prompt. Returns 204 immediately; the response streams
 * via GET /event SSE.
 */
export async function promptAsync(
  sessionId: string,
  text: string,
  opts?: { agent?: string; model?: string; directory?: string; system?: string }
): Promise<void> {
  const body: Record<string, unknown> = {
    model: modelFromId(opts?.model ?? DEFAULT_MODEL),
    agent: opts?.agent ?? DEFAULT_AGENT,
    parts: [{ type: "text", text }],
  };

  if (opts?.system) {
    body["system"] = opts.system;
  }

  const url = `${BASE_URL}${withDirectory(
    `/session/${encodeURIComponent(sessionId)}/prompt_async`,
    opts?.directory
  )}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "(unreadable body)");
    throw new Error(
      `OpenCode prompt_async error ${res.status} ${res.statusText}: ${errBody}`
    );
  }
  // 204 — no body to consume
}

/**
 * Returns the raw fetch Response for the global SSE event stream.
 * The caller is responsible for reading and closing the body.
 */
export async function openEventStream(directory?: string): Promise<Response> {
  const url = `${BASE_URL}${withDirectory("/event", directory)}`;
  const res = await fetch(url, {
    headers: { Accept: "text/event-stream" },
    // Node 18+ fetch supports streaming; no special flags needed
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "(unreadable body)");
    throw new Error(
      `OpenCode /event error ${res.status} ${res.statusText}: ${errBody}`
    );
  }

  return res;
}

/**
 * Returns the cumulative token usage for a session as a single total.
 * total = input + output + cache.read + cache.write
 */
export async function getSessionTokens(
  sessionId: string
): Promise<number> {
  const detail = await request<OpenCodeSessionDetail>(
    `/session/${encodeURIComponent(sessionId)}`
  );
  const t = detail.tokens;
  return (t.input ?? 0) + (t.output ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
}

/**
 * Returns the full token breakdown for a session.
 *
 * WARNING: this is the engine's CUMULATIVE lifetime token sum (a billing
 * counter that grows every turn). It is NOT the current context-window
 * occupancy. For the %-context meter use `getLatestContextTokens` instead.
 */
export async function getSessionTokensDetail(
  sessionId: string
): Promise<OpenCodeTokensDetail> {
  const detail = await request<OpenCodeSessionDetail>(
    `/session/${encodeURIComponent(sessionId)}`
  );
  return detail.tokens;
}

export interface OpenCodeContextTokens extends OpenCodeTokensDetail {
  total?: number;
}

/**
 * Returns the LATEST assistant message's own token usage — the true current
 * context-window occupancy of the most recent turn (system + full prior
 * conversation + documents + this reply). This is bounded by the model's
 * context window and matches the engine's own overflow/compaction math.
 *
 * This replaces reading the session-level cumulative `tokens` (which is a
 * lifetime sum that grows ~quadratically with turn count).
 */
export async function getLatestContextTokens(
  sessionId: string,
  directory: string
): Promise<OpenCodeContextTokens> {
  const entries = await request<OpenCodeHistoryEntry[]>(
    withDirectory(
      `/session/${encodeURIComponent(sessionId)}/message`,
      directory
    )
  );

  for (let i = entries.length - 1; i >= 0; i--) {
    const info = entries[i]?.info;
    if (info?.role === "assistant" && info.tokens) {
      const t = info.tokens;
      return {
        total: t.total,
        input: t.input ?? 0,
        output: t.output ?? 0,
        reasoning: t.reasoning ?? 0,
        cache: { read: t.cache?.read ?? 0, write: t.cache?.write ?? 0 },
      };
    }
  }

  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
}

/**
 * Collapses a context-tokens object to a single occupancy number, preferring
 * the engine-provided `total` and falling back to the component sum.
 */
export function contextUsedTokens(t: OpenCodeContextTokens): number {
  if (typeof t.total === "number" && t.total > 0) return t.total;
  return (
    (t.input ?? 0) +
    (t.output ?? 0) +
    (t.cache?.read ?? 0) +
    (t.cache?.write ?? 0)
  );
}

/**
 * Returns the context window limit for deepseek-v4-flash from the opencode-go
 * provider. Result is cached in-module. Falls back to 128 000 if not found.
 */
export async function getProviderContextLimit(): Promise<number> {
  if (_cachedContextLimit !== null) {
    return _cachedContextLimit;
  }

  try {
    const data = await request<OpenCodeProviderList>("/provider");
    const provider = data.all.find((p) => p.id === "opencode-go");
    const model = provider?.models["deepseek-v4-flash"];
    const limit = model?.limit?.context ?? 128_000;
    _cachedContextLimit = limit;
    return limit;
  } catch {
    return 128_000;
  }
}

/**
 * Returns the todo list for a session.
 */
export async function getTodos(
  sessionId: string
): Promise<OpenCodeTodo[]> {
  return request<OpenCodeTodo[]>(
    `/session/${encodeURIComponent(sessionId)}/todo`
  );
}

/**
 * Returns the current status for a session ("idle" | "busy" | ...).
 * Defaults to "idle" if the session is not found in the status map.
 */
export async function getSessionStatus(
  sessionId: string
): Promise<string> {
  const statusMap = await request<OpenCodeSessionStatusMap>(
    "/session/status"
  );
  return statusMap[sessionId]?.type ?? "idle";
}

/**
 * Aborts the current turn for a session.
 * POST /session/:id/abort?directory=
 */
export async function abortSession(
  sessionId: string,
  directory: string
): Promise<void> {
  const url = `${BASE_URL}${withDirectory(
    `/session/${encodeURIComponent(sessionId)}/abort`,
    directory
  )}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "(unreadable body)");
    throw new Error(
      `OpenCode abort error ${res.status} ${res.statusText}: ${errBody}`
    );
  }
}

/**
 * Reverts a session to a prior message, deleting messages >= messageID.
 * POST /session/:id/revert?directory= body {messageID}
 * Returns 409 if the session is busy.
 */
export async function revertSession(
  sessionId: string,
  messageID: string,
  directory: string
): Promise<void> {
  const url = `${BASE_URL}${withDirectory(
    `/session/${encodeURIComponent(sessionId)}/revert`,
    directory
  )}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messageID }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "(unreadable body)");
    throw new Error(
      `OpenCode revert error ${res.status} ${res.statusText}: ${errBody}`
    );
  }
}

/**
 * Fetches the message history for a session.
 * GET /session/:id/message?directory=
 * Concatenates text parts (excluding reasoning) for each message's text.
 * Collects tool parts into the tools array.
 */
export async function getMessages(
  sessionId: string,
  directory: string
): Promise<MessageHistoryItem[]> {
  const entries = await request<OpenCodeHistoryEntry[]>(
    withDirectory(
      `/session/${encodeURIComponent(sessionId)}/message`,
      directory
    )
  );

  const mapped = entries.map((entry) => {
    const textParts = entry.parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string);

    const tools = entry.parts
      .filter((p) => p.type === "tool" && typeof p.tool === "string")
      .map((p) => ({
        name: p.tool as string,
        status: p.state?.status ?? "unknown",
        input: p.state?.input,
        output: p.state?.output,
      }));

    return {
      id: entry.info.id,
      role: entry.info.role,
      text: textParts.join(""),
      createdAt: entry.info.time.created,
      tools,
    };
  });

  // The engine emits ONE assistant message per step (read, write, todowrite,
  // task, …). Merge consecutive assistant messages into a single logical turn
  // so the UI shows one tool-activity strip + one answer per turn, instead of a
  // separate bubble/line for every step. User messages are turn boundaries.
  const merged: MessageHistoryItem[] = [];
  for (const item of mapped) {
    const last = merged[merged.length - 1];
    if (item.role === "assistant" && last && last.role === "assistant") {
      last.tools = [...last.tools, ...item.tools];
      if (item.text) {
        last.text = last.text ? `${last.text}\n\n${item.text}` : item.text;
      }
    } else {
      merged.push({ ...item, tools: [...item.tools] });
    }
  }
  return merged;
}
