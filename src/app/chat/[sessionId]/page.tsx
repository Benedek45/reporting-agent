"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import type { ChatMessage, UploadInfo } from "@/types";

// TODO(scaffold): switch to GET /event SSE for token streaming instead of
// awaiting the full reply from POST /api/chat.

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

type LoadState = "idle" | "loading" | "loaded" | "too-large";

export default function ChatPage() {
  const params = useParams();
  const sessionId = params.sessionId as string;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Uploads panel state
  const [uploads, setUploads] = useState<UploadInfo[]>([]);
  const [loadStates, setLoadStates] = useState<Record<string, LoadState>>({});
  const [dropActive, setDropActive] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropzoneInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function appendMessage(role: ChatMessage["role"], text: string) {
    setMessages((prev) => [
      ...prev,
      { id: generateId(), role, text, createdAt: Date.now() },
    ]);
  }

  const refreshUploads = useCallback(async () => {
    try {
      const res = await fetch(`/api/uploads?sessionId=${encodeURIComponent(sessionId)}`);
      if (!res.ok) return;
      const data = (await res.json()) as { uploads: UploadInfo[] };
      setUploads(data.uploads);
    } catch {
      // Non-fatal: uploads panel just won't update
    }
  }, [sessionId]);

  // Load uploads on mount
  useEffect(() => {
    void refreshUploads();
  }, [refreshUploads]);

  async function uploadFiles(files: File[]) {
    if (files.length === 0 || uploading) return;

    setUploading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("sessionId", sessionId);
      for (const file of files) {
        formData.append("files", file);
      }

      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Upload error ${res.status}`);
      }

      await refreshUploads();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;

    setInput("");
    setError(null);
    appendMessage("user", text);
    setSending(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, text }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `Server error ${res.status}`);
      }

      const data = (await res.json()) as { reply: string };
      appendMessage("assistant", data.reply);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setSending(false);
    }
  }

  async function handleLoadIntoContext(fileName: string) {
    setLoadStates((prev) => ({ ...prev, [fileName]: "loading" }));

    try {
      const res = await fetch("/api/context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, fileName }),
      });

      if (res.status === 413) {
        setLoadStates((prev) => ({ ...prev, [fileName]: "too-large" }));
        return;
      }

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Error ${res.status}`);
      }

      const data = (await res.json()) as { reply: string; loadedBytes: number };
      appendMessage("assistant", data.reply);
      setLoadStates((prev) => ({ ...prev, [fileName]: "loaded" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load file into context");
      setLoadStates((prev) => ({ ...prev, [fileName]: "idle" }));
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  function handleDownloadReport() {
    // TODO(scaffold): fetch /api/report?sessionId=... which reads
    // <workspace>/output/report.md and streams it as a file download.
    alert("Download not yet implemented.");
  }

  // Drag-and-drop handlers
  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDropActive(true);
  }

  function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
    // Only deactivate if leaving the dropzone itself (not a child)
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropActive(false);
    }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDropActive(false);
    const files = Array.from(e.dataTransfer.files);
    void uploadFiles(files);
  }

  function handleDropzoneClick() {
    dropzoneInputRef.current?.click();
  }

  function handleDropzoneInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    void uploadFiles(files);
    // Reset so the same file can be re-selected
    if (dropzoneInputRef.current) dropzoneInputRef.current.value = "";
  }

  // Legacy file input (kept for compatibility, now hidden)
  function handleLegacyUpload() {
    const files = Array.from(fileInputRef.current?.files ?? []);
    void uploadFiles(files);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  return (
    <div className="chat-layout">
      <div className="chat-header">
        <h2>Compliance Interview</h2>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button
            className="btn btn-secondary"
            onClick={handleDownloadReport}
          >
            Download report
          </button>
        </div>
      </div>

      <div className="chat-messages">
        {messages.length === 0 && (
          <p className="status-text">
            The agent will begin the interview once you send your first message.
          </p>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`msg ${msg.role}`}>
            {msg.text}
          </div>
        ))}
        {sending && (
          <div className="msg assistant status-text">Thinking…</div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {error && <p className="error-text">{error}</p>}

      {/* Drag-and-drop dropzone */}
      <div
        className={`dropzone${dropActive ? " active" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleDropzoneClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") handleDropzoneClick();
        }}
        aria-label="Upload source documents"
      >
        <input
          ref={dropzoneInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={handleDropzoneInputChange}
        />
        {uploading ? (
          <span>Uploading…</span>
        ) : (
          <span>
            Drop source documents here, or <strong>click to browse</strong>
          </span>
        )}
      </div>

      {/* Uploads panel */}
      {uploads.length > 0 && (
        <div className="uploads">
          <p className="hint">Uploaded documents</p>
          {uploads.map((u) => {
            const state = loadStates[u.name] ?? "idle";
            return (
              <div key={u.name} className="upload-row">
                <span className="upload-name" title={u.name}>{u.name}</span>
                <span className="upload-size">{formatBytes(u.size)}</span>
                {state === "too-large" ? (
                  <span className="note">
                    Too large to load fully — the agent will read it on demand instead.
                  </span>
                ) : state === "loaded" ? (
                  <span className="loaded-badge">Loaded ✓</span>
                ) : (
                  <button
                    className="btn btn-secondary"
                    disabled={state === "loading"}
                    onClick={() => void handleLoadIntoContext(u.name)}
                  >
                    {state === "loading" ? "Loading…" : "Load into context"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Hidden legacy file input — kept for reference, superseded by dropzone */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={handleLegacyUpload}
      />

      <div className="chat-input-bar">
        <textarea
          rows={2}
          placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={sending}
        />
        <button
          className="btn btn-primary"
          disabled={sending || !input.trim()}
          onClick={() => void handleSend()}
        >
          Send
        </button>
      </div>
    </div>
  );
}
