export type TaskId = "csrd" | "esg";

export interface Task {
  id: TaskId;
  label: string;
  blurb: string;
  agent: string;
  skill: string;
  templatePath: string;
}

export interface Goal {
  id: string;
  title: string;
  agent: string;
  skill: string;
  templatePath: string;
  body: string;
}

export interface SessionInfo {
  id: string;
  taskId: TaskId;
  goalId?: string;
  title?: string;
  createdAt: number;
}

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  createdAt: number;
}

export interface UploadInfo {
  name: string;
  size: number;
}

// ── File listing ──────────────────────────────────────────────────────────────

export type FileKind = "upload" | "report" | "goal";
export type DownloadFormat = "original" | "md" | "pdf" | "docx";

export interface EnvFile {
  name: string;
  kind: FileKind;
  size: number;
  ext: string;
  canDeleteDirectly: boolean;
  downloadFormats: DownloadFormat[];
}

// ── Session state ─────────────────────────────────────────────────────────────

export interface SessionState {
  workspaceId: string;
  messageCount: number;
  uploads: Record<string, number>; // fileName → messageCount at upload time
  /** Epoch ms of the last time-injection sent to the model (undefined = never). */
  lastTimeUpdateMs?: number;
  /** Goal body text stored at session creation for first-turn injection. */
  goalText?: string;
  /** Cumulative bytes of files loaded into context via /api/context. */
  loadedContextBytes?: number;
}

export interface SessionTokenUsage {
  usedTokens: number;
  contextLimit: number;
  pct: number;
}

export interface TodoItem {
  content: string;
  status: string;
  priority: string;
}

// ── Tool event ────────────────────────────────────────────────────────────────

export interface ToolEvent {
  id: string;
  name: string;
  status: "pending" | "running" | "completed" | "error";
  title?: string;
  input?: unknown;
  output?: string;
  error?: string;
}

// ── Context breakdown ─────────────────────────────────────────────────────────

export interface ContextBreakdownItem {
  label: string;
  tokens: number;
}

// ── Message history ───────────────────────────────────────────────────────────

export interface MessageHistoryItem {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  tools: {
    name: string;
    status: string;
    input?: unknown;
    output?: string;
  }[];
}

// ── SSE event union (downstream protocol from /api/chat/stream) ───────────────

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | ({ type: "tool" } & ToolEvent)
  | { type: "todos"; todos: TodoItem[] }
  | { type: "status"; status: string }
  | {
      type: "usage";
      usedTokens: number;
      contextLimit: number;
      pct: number;
      breakdown: ContextBreakdownItem[];
    }
  | { type: "done" }
  | { type: "error"; error: string };
