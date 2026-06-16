"use client";

import { useState, useRef, useEffect } from "react";
import { useParams } from "next/navigation";
import type { ChatMessage, UploadInfo } from "@/types";

// TODO(scaffold): switch to GET /event SSE for token streaming instead of
// awaiting the full reply from POST /api/chat.

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export default function ChatPage() {
  const params = useParams();
  const sessionId = params.sessionId as string;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function appendMessage(role: ChatMessage["role"], text: string) {
    setMessages((prev) => [
      ...prev,
      { id: generateId(), role, text, createdAt: Date.now() },
    ]);
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

  async function handleUpload() {
    const files = fileInputRef.current?.files;
    if (!files || files.length === 0 || uploading) return;

    setUploading(true);
    setUploadStatus(null);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("sessionId", sessionId);
      for (const file of Array.from(files)) {
        formData.append("files", file);
      }

      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `Upload error ${res.status}`);
      }

      const data = (await res.json()) as { uploaded: UploadInfo[] };
      const names = data.uploaded.map((u) => u.name).join(", ");
      setUploadStatus(`Uploaded: ${names}`);

      // Reset file input
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
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

      <div className="upload-bar">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ fontSize: "0.85rem" }}
        />
        <button
          className="btn btn-secondary"
          disabled={uploading}
          onClick={() => void handleUpload()}
        >
          {uploading ? "Uploading…" : "Upload"}
        </button>
        {uploadStatus && <span>{uploadStatus}</span>}
      </div>

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
