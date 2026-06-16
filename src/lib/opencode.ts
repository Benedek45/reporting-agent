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
