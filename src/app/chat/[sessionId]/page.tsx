"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import type { ChatMessage, EnvFile, TodoItem, StreamEvent } from "@/types";
import DocumentsSidebar from "@/app/_components/DocumentsSidebar";
import Thinking from "@/app/_components/Thinking";
import ContextMeter from "@/app/_components/ContextMeter";
import TodoPanel from "@/app/_components/TodoPanel";

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ── SSE reader ────────────────────────────────────────────────────────────────

/**
 * Parse one or more SSE frames from a raw text chunk.
 * Handles partial frames: returns parsed events and any leftover partial frame.
 */
function parseSseChunk(
  buffer: string,
  newChunk: string
): { events: StreamEvent[]; remaining: string } {
  const combined = buffer + newChunk;
  const frames = combined.split("\n\n");
  // The last element may be a partial frame (no trailing \n\n yet)
  const remaining = frames.pop() ?? "";
  const events: StreamEvent[] = [];

  for (const frame of frames) {
    const lines = frame.split("\n");
    let dataLine = "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        dataLine = line.slice(6);
      }
    }
    if (!dataLine) continue;
    try {
      const parsed = JSON.parse(dataLine) as StreamEvent;
      events.push(parsed);
    } catch {
      // Malformed frame — skip
    }
  }

  return { events, remaining };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ChatPage() {
  const params = useParams();
  const sessionId = params.sessionId as string;

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Streaming in-progress assistant message
  const [streamingText, setStreamingText] = useState<string | null>(null);
  // Live reasoning (shown in the Thinking box, kept out of the answer bubble)
  const [reasoningText, setReasoningText] = useState("");

  // Right panel state
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [usedTokens, setUsedTokens] = useState(0);
  const [contextLimit, setContextLimit] = useState(200_000);
  const [contextPct, setContextPct] = useState(0);

  // Left sidebar files
  const [files, setFiles] = useState<EnvFile[]>([]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  function appendMessage(role: ChatMessage["role"], text: string) {
    setMessages((prev) => [
      ...prev,
      { id: generateId(), role, text, createdAt: Date.now() },
    ]);
  }

  const refreshFiles = useCallback(async () => {
    try {
      const res = await fetch(`/api/files?sessionId=${encodeURIComponent(sessionId)}`);
      if (!res.ok) return;
      const data = (await res.json()) as { files: EnvFile[] };
      setFiles(data.files);
    } catch {
      // Non-fatal
    }
  }, [sessionId]);

  const refreshState = useCallback(async () => {
    try {
      const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}/state`);
      if (!res.ok) return;
      const data = (await res.json()) as {
        usedTokens: number;
        contextLimit: number;
        pct: number;
        todos: TodoItem[];
        status: string;
      };
      setUsedTokens(data.usedTokens);
      setContextLimit(data.contextLimit);
      setContextPct(data.pct);
      setTodos(data.todos);
    } catch {
      // Non-fatal
    }
  }, [sessionId]);

  // Load initial state on mount
  useEffect(() => {
    void refreshFiles();
    void refreshState();
  }, [refreshFiles, refreshState]);

  // Cleanup abort controller on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // ── Send (streaming) ───────────────────────────────────────────────────────

  async function handleSend() {
    const text = input.trim();
    if (!text || busy) return;

    setInput("");
    setError(null);
    appendMessage("user", text);
    setBusy(true);
    setStreamingText("");
    setReasoningText("");

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, text }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Server error ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";
      let accumulatedText = "";
      let finalized = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const { events, remaining } = parseSseChunk(sseBuffer, chunk);
        sseBuffer = remaining;

        for (const event of events) {
          switch (event.type) {
            case "text":
              accumulatedText += event.delta;
              setStreamingText(accumulatedText);
              break;

            case "reasoning":
              // Keep reasoning out of the answer; show the tail in the Thinking box.
              setReasoningText((prev) => (prev + event.delta).slice(-500));
              break;

            case "todos":
              setTodos(event.todos);
              break;

            case "status":
              // busy state is already managed by the outer try/finally
              break;

            case "usage":
              setUsedTokens(event.usedTokens);
              setContextLimit(event.contextLimit);
              setContextPct(event.pct);
              break;

            case "done":
              // Finalize the streamed message
              if (accumulatedText) {
                appendMessage("assistant", accumulatedText);
              }
              finalized = true;
              setStreamingText(null);
              setBusy(false);
              void refreshFiles();
              void refreshState();
              break;

            case "error":
              setError(event.error);
              finalized = true;
              setStreamingText(null);
              setBusy(false);
              break;
          }
        }
      }

      // Stream ended without a "done" frame — finalize anyway
      if (!finalized && accumulatedText) {
        appendMessage("assistant", accumulatedText);
      }
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setStreamingText(null);
      setReasoningText("");
      setBusy(false);
      abortRef.current = null;
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="chat-page-layout">
      {/* Left sidebar — documents */}
      <DocumentsSidebar
        sessionId={sessionId}
        files={files}
        onFilesChanged={() => void refreshFiles()}
        onAssistantMessage={(text) => appendMessage("assistant", text)}
        onError={(msg) => setError(msg)}
      />

      {/* Center — chat */}
      <main className="chat-center">
        <div className="chat-header">
          <h2>Compliance Interview</h2>
        </div>

        <div className="chat-messages">
          {messages.length === 0 && !busy && (
            <p className="status-text">
              The agent will begin the interview once you send your first message.
            </p>
          )}

          {messages.map((msg) => (
            <div key={msg.id} className={`msg ${msg.role}`}>
              {msg.text}
            </div>
          ))}

          {/* In-progress streaming bubble */}
          {streamingText !== null && (
            <div className="msg assistant msg-streaming">
              {streamingText || <span className="msg-streaming-cursor" />}
            </div>
          )}

          {/* Thinking indicator (shown when busy but no text yet) */}
          <Thinking active={busy && streamingText === ""} reasoning={reasoningText} />

          <div ref={messagesEndRef} />
        </div>

        {error && <p className="error-text">{error}</p>}

        <div className="chat-input-bar">
          <textarea
            rows={2}
            placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={busy}
            aria-label="Message input"
          />
          <button
            className="btn btn-primary"
            disabled={busy || !input.trim()}
            onClick={() => void handleSend()}
          >
            {busy ? "Sending…" : "Send"}
          </button>
        </div>
      </main>

      {/* Right sidebar — status */}
      <aside className="status-sidebar">
        <ContextMeter
          usedTokens={usedTokens}
          contextLimit={contextLimit}
          pct={contextPct}
        />
        <TodoPanel todos={todos} />
      </aside>
    </div>
  );
}
