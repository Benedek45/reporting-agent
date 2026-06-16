// server-only

const BASE_URL =
  process.env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4096";

const DEFAULT_AGENT = "compliance";
const DEFAULT_MODEL = "opencode-go/deepseek-v4-flash";

interface OpenCodePart {
  type: string;
  text?: string;
}

interface OpenCodeMessageResponse {
  info: unknown;
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

interface OpenCodeTokens {
  input: number;
  output: number;
  reasoning: number;
  cache: {
    read: number;
    write: number;
  };
}

interface OpenCodeSessionDetail {
  tokens: OpenCodeTokens;
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

// In-module cache for the provider context limit
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

export async function sendMessage(
  sessionId: string,
  text: string,
  opts?: { agent?: string; model?: string; directory?: string }
): Promise<{ text: string }> {
  const body = {
    model: modelFromId(opts?.model ?? DEFAULT_MODEL),
    agent: opts?.agent ?? DEFAULT_AGENT,
    parts: [{ type: "text", text }],
  };

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
  opts?: { agent?: string; model?: string; directory?: string }
): Promise<void> {
  const body = {
    model: modelFromId(opts?.model ?? DEFAULT_MODEL),
    agent: opts?.agent ?? DEFAULT_AGENT,
    parts: [{ type: "text", text }],
  };

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
