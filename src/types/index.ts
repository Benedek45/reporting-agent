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

// ── SSE event union (downstream protocol from /api/chat/stream) ───────────────

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "todos"; todos: TodoItem[] }
  | { type: "status"; status: string }
  | { type: "usage"; usedTokens: number; contextLimit: number; pct: number }
  | { type: "done" }
  | { type: "error"; error: string };
