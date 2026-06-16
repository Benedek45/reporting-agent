export type TaskId = "csrd" | "esg";

export interface Task {
  id: TaskId;
  label: string;
  blurb: string;
  agent: string;
  skill: string;
  templatePath: string;
}

export interface SessionInfo {
  id: string;
  taskId: TaskId;
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
