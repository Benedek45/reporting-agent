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

export async function createSession(title: string): Promise<{ id: string }> {
  const session = await request<OpenCodeSession>("/session", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  return { id: session.id };
}

export async function sendMessage(
  sessionId: string,
  text: string,
  opts?: { agent?: string; model?: string }
): Promise<{ text: string }> {
  const body = {
    model: opts?.model ?? DEFAULT_MODEL,
    agent: opts?.agent ?? DEFAULT_AGENT,
    parts: [{ type: "text", text }],
  };

  const response = await request<OpenCodeMessageResponse>(
    `/session/${sessionId}/message`,
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
