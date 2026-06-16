"use client";

import { useState, useRef, useEffect, useCallback, useLayoutEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import type {
  EnvFile,
  TodoItem,
  StreamEvent,
  ToolEvent,
  ContextBreakdownItem,
  MessageHistoryItem,
} from "@/types";
import DocumentsSidebar from "@/app/_components/DocumentsSidebar";
import Thinking from "@/app/_components/Thinking";
import ContextMeter from "@/app/_components/ContextMeter";
import TodoPanel from "@/app/_components/TodoPanel";
import MarkdownMessage from "@/app/_components/MarkdownMessage";
import ToolCallChip from "@/app/_components/ToolCallChip";
import ThemeToggle from "@/app/_components/ThemeToggle";
import ReportPreview from "@/app/_components/ReportPreview";

// ── Types ─────────────────────────────────────────────────────────────────────

interface UIMessage {
  /** Stable id — from history API or locally generated */
  id: string;
  /** opencode message id (for edit) — only set for history-loaded messages */
  ocId?: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  tools: ToolEvent[];
  pinned: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatFullTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

// ── SSE reader ────────────────────────────────────────────────────────────────

function parseSseChunk(
  buffer: string,
  newChunk: string
): { events: StreamEvent[]; remaining: string } {
  const combined = buffer + newChunk;
  const frames = combined.split("\n\n");
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
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Streaming in-progress assistant message
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [streamingTools, setStreamingTools] = useState<ToolEvent[]>([]);
  const [reasoningText, setReasoningText] = useState("");

  // Edit mode
  const [editingMsg, setEditingMsg] = useState<{ uiId: string; ocId: string; text: string } | null>(null);

  // Pinned messages
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());

  // Right panel state
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [usedTokens, setUsedTokens] = useState(0);
  const [contextLimit, setContextLimit] = useState(1_000_000);
  const [contextPct, setContextPct] = useState(0);
  const [breakdown, setBreakdown] = useState<ContextBreakdownItem[]>([]);

  // Left sidebar files
  const [files, setFiles] = useState<EnvFile[]>([]);

  // Report preview
  const [reportMarkdown, setReportMarkdown] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const msgRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  // ── Helpers ────────────────────────────────────────────────────────────────

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
        breakdown?: ContextBreakdownItem[];
      };
      setUsedTokens(data.usedTokens);
      setContextLimit(data.contextLimit);
      setContextPct(data.pct);
      setTodos(data.todos);
      if (data.breakdown) setBreakdown(data.breakdown);
    } catch {
      // Non-fatal
    }
  }, [sessionId]);

  const refreshReport = useCallback(async () => {
    try {
      const res = await fetch(`/api/report?sessionId=${encodeURIComponent(sessionId)}`);
      if (!res.ok) return;
      const data = (await res.json()) as { exists: boolean; markdown: string };
      if (data.exists) setReportMarkdown(data.markdown);
    } catch {
      // Non-fatal
    }
  }, [sessionId]);

  const refreshHistory = useCallback(async () => {
    try {
      const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}/messages`);
      if (!res.ok) return;
      const data = (await res.json()) as { messages: MessageHistoryItem[] };
      setMessages((prev) => {
        // Preserve pinned state from existing messages
        const pinnedMap = new Map(prev.map((m) => [m.id, m.pinned]));
        return data.messages.map((m) => ({
          id: m.id,
          ocId: m.id,
          role: m.role,
          text: m.text,
          createdAt: m.createdAt,
          tools: m.tools
            .map((t, i) => ({
              id: `${m.id}-tool-${i}`,
              name: t.name,
              status: (t.status as ToolEvent["status"]) ?? "completed",
              input: t.input,
              output: t.output,
            }))
            .filter((t) => t.status !== "error"),
          pinned: pinnedMap.get(m.id) ?? false,
        }));
      });
    } catch {
      // Non-fatal
    }
  }, [sessionId]);

  // Load initial state on mount
  useEffect(() => {
    void refreshFiles();
    void refreshState();
    void refreshReport();

    // Load history; if empty, show welcome from sessionStorage
    fetch(`/api/session/${encodeURIComponent(sessionId)}/messages`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { messages: MessageHistoryItem[] } | null) => {
        if (data && data.messages.length > 0) {
          setMessages(
            data.messages.map((m) => ({
              id: m.id,
              ocId: m.id,
              role: m.role,
              text: m.text,
              createdAt: m.createdAt,
              tools: m.tools
                .map((t, i) => ({
                  id: `${m.id}-tool-${i}`,
                  name: t.name,
                  status: (t.status as ToolEvent["status"]) ?? "completed",
                  input: t.input,
                  output: t.output,
                }))
                .filter((t) => t.status !== "error"),
              pinned: false,
            }))
          );
        } else {
          // Try welcome from sessionStorage
          try {
            const welcome = sessionStorage.getItem(`welcome:${sessionId}`);
            if (welcome) {
              sessionStorage.removeItem(`welcome:${sessionId}`);
              setMessages([
                {
                  id: generateId(),
                  role: "assistant",
                  text: welcome,
                  createdAt: Date.now(),
                  tools: [],
                  pinned: false,
                },
              ]);
            }
          } catch {
            // sessionStorage unavailable
          }
        }
      })
      .catch(() => {
        // Non-fatal — try welcome fallback
        try {
          const welcome = sessionStorage.getItem(`welcome:${sessionId}`);
          if (welcome) {
            sessionStorage.removeItem(`welcome:${sessionId}`);
            setMessages([
              {
                id: generateId(),
                role: "assistant",
                text: welcome,
                createdAt: Date.now(),
                tools: [],
                pinned: false,
              },
            ]);
          }
        } catch {
          // ignore
        }
      });
  }, [sessionId, refreshFiles, refreshState, refreshReport]);

  // Cleanup abort controller on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // ── Core stream function ───────────────────────────────────────────────────

  async function runStream(body: {
    sessionId: string;
    text?: string;
    editMessageId?: string;
    loadFileName?: string;
  }) {
    setBusy(true);
    setStreamingText("");
    setStreamingTools([]);
    setReasoningText("");
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error ?? `Server error ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";
      let accumulatedText = "";
      // Map from tool id → ToolEvent (live during stream)
      const liveTools = new Map<string, ToolEvent>();
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
              setReasoningText((prev) => (prev + event.delta).slice(-500));
              break;

            case "tool": {
              const te: ToolEvent = {
                id: event.id,
                name: event.name,
                status: event.status,
                title: event.title,
                input: event.input,
                output: event.output,
                error: event.error,
              };
              liveTools.set(event.id, te);
              setStreamingTools(Array.from(liveTools.values()));
              break;
            }

            case "todos":
              setTodos(event.todos);
              break;

            case "status":
              break;

            case "usage":
              setUsedTokens(event.usedTokens);
              setContextLimit(event.contextLimit);
              setContextPct(event.pct);
              if (event.breakdown) setBreakdown(event.breakdown);
              break;

            case "done":
              if (accumulatedText || liveTools.size > 0) {
                const finalTools = Array.from(liveTools.values());
                setMessages((prev) => [
                  ...prev,
                  {
                    id: generateId(),
                    role: "assistant",
                    text: accumulatedText,
                    createdAt: Date.now(),
                    tools: finalTools,
                    pinned: false,
                  },
                ]);
              }
              finalized = true;
              setStreamingText(null);
              setStreamingTools([]);
              setBusy(false);
              void refreshFiles();
              void refreshState();
              void refreshReport();
              break;

            case "error":
              setError(event.error);
              finalized = true;
              setStreamingText(null);
              setStreamingTools([]);
              setBusy(false);
              break;
          }
        }
      }

      if (!finalized && (accumulatedText || liveTools.size > 0)) {
        const finalTools = Array.from(liveTools.values());
        setMessages((prev) => [
          ...prev,
          {
            id: generateId(),
            role: "assistant",
            text: accumulatedText,
            createdAt: Date.now(),
            tools: finalTools,
            pinned: false,
          },
        ]);
      }
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setStreamingText(null);
      setStreamingTools([]);
      setReasoningText("");
      setBusy(false);
      abortRef.current = null;
    }
  }

  // ── Send ───────────────────────────────────────────────────────────────────

  async function handleSend() {
    const text = input.trim();
    if (!text || busy) return;

    setInput("");

    if (editingMsg) {
      // Edit mode: replace messages after the edited one and re-stream
      const ocId = editingMsg.ocId;
      setEditingMsg(null);

      // Optimistically truncate messages up to (not including) the edited message
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.ocId === ocId);
        if (idx === -1) return prev;
        // Replace the edited message text and drop everything after it
        const updated = prev.slice(0, idx);
        updated.push({
          ...prev[idx],
          text,
          createdAt: Date.now(),
        });
        return updated;
      });

      await runStream({ sessionId, text, editMessageId: ocId });

      // After edit, refetch history to reflect server-side truncation
      void refreshHistory();
    } else {
      // Normal send
      setMessages((prev) => [
        ...prev,
        {
          id: generateId(),
          role: "user",
          text,
          createdAt: Date.now(),
          tools: [],
          pinned: false,
        },
      ]);

      await runStream({ sessionId, text });
    }
  }

  // ── Stream action (sidebar-triggered) ─────────────────────────────────────

  async function handleStreamAction(opts: { text?: string; loadFileName?: string }) {
    if (busy) return;

    if (opts.text) {
      // Show as a user message
      setMessages((prev) => [
        ...prev,
        {
          id: generateId(),
          role: "user",
          text: opts.text!,
          createdAt: Date.now(),
          tools: [],
          pinned: false,
        },
      ]);
    }

    await runStream({ sessionId, text: opts.text, loadFileName: opts.loadFileName });
  }

  // ── Stop ───────────────────────────────────────────────────────────────────

  async function handleStop() {
    abortRef.current?.abort();
    try {
      await fetch("/api/chat/abort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
    } catch {
      // Non-fatal
    }
  }

  // ── Edit ───────────────────────────────────────────────────────────────────

  function startEdit(msg: UIMessage) {
    if (!msg.ocId) return;
    setEditingMsg({ uiId: msg.id, ocId: msg.ocId, text: msg.text });
    setInput(msg.text);
    textareaRef.current?.focus();
  }

  function cancelEdit() {
    setEditingMsg(null);
    setInput("");
  }

  // ── Pin ────────────────────────────────────────────────────────────────────

  function togglePin(id: string) {
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, pinned: !m.pinned } : m))
    );
  }

  function scrollToMessage(id: string) {
    const el = msgRefs.current.get(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
    if (e.key === "Escape" && editingMsg) {
      cancelEdit();
    }
  }

  // ── Auto-grow textarea ─────────────────────────────────────────────────────

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  // ── Pinned bar ─────────────────────────────────────────────────────────────

  const pinnedMessages = messages.filter((m) => m.pinned);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="chat-page-layout">
      {/* Left sidebar — documents */}
      <DocumentsSidebar
        sessionId={sessionId}
        files={files}
        onFilesChanged={() => void refreshFiles()}
        onStreamAction={(opts) => void handleStreamAction(opts)}
        onError={(msg) => setError(msg)}
      />

      {/* Center — chat */}
      <main className="chat-center">
        <div className="chat-header">
          <Link href="/" className="back-link" title="Back to main menu">
            ← Menu
          </Link>
          <h2>Compliance Interview</h2>
          <div className="chat-header-actions">
            <ThemeToggle />
          </div>
        </div>

        <div className="chat-messages">
          {messages.length === 0 && !busy && (
            <p className="status-text">
              The agent will begin the interview once you send your first message.
            </p>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`msg-wrapper ${msg.role}`}
              ref={(el) => {
                if (el) msgRefs.current.set(msg.id, el);
                else msgRefs.current.delete(msg.id);
              }}
            >
              {/* Tool chips (assistant only, before the text) */}
              {msg.role === "assistant" && msg.tools.length > 0 && (
                <div className="tool-calls">
                  {msg.tools.map((t) => (
                    <ToolCallChip key={t.id} tool={t} />
                  ))}
                </div>
              )}

              <div className={`msg ${msg.role}`}>
                {msg.role === "assistant" ? (
                  <MarkdownMessage content={msg.text} />
                ) : (
                  msg.text
                )}
              </div>

              {/* Meta row */}
              <div className="msg-meta">
                <span
                  className="msg-timestamp"
                  title={formatFullTime(msg.createdAt)}
                >
                  {formatTime(msg.createdAt)}
                </span>
                <button
                  className={`msg-pin-btn${msg.pinned ? " pinned" : ""}`}
                  onClick={() => togglePin(msg.id)}
                  title={msg.pinned ? "Unpin" : "Pin message"}
                  aria-label={msg.pinned ? "Unpin message" : "Pin message"}
                >
                  {msg.pinned ? "📌" : "📍"}
                </button>
                {msg.role === "user" && msg.ocId && (
                  <button
                    className="msg-edit-btn"
                    onClick={() => startEdit(msg)}
                    title="Edit message"
                    aria-label="Edit message"
                  >
                    ✎
                  </button>
                )}
              </div>
            </div>
          ))}

          {/* In-progress streaming bubble */}
          {streamingText !== null && (
            <div className="msg-wrapper assistant">
              {streamingTools.length > 0 && (
                <div className="tool-calls">
                  {streamingTools.map((t) => (
                    <ToolCallChip key={t.id} tool={t} />
                  ))}
                </div>
              )}
              <div className="msg assistant msg-streaming">
                {streamingText ? (
                  <MarkdownMessage content={streamingText} />
                ) : (
                  <span className="msg-streaming-cursor" />
                )}
              </div>
            </div>
          )}

          {/* Thinking indicator (shown when busy but no text yet) */}
          <Thinking active={busy && streamingText === ""} reasoning={reasoningText} />

          <div ref={messagesEndRef} />
        </div>

        {/* Pinned messages bar */}
        {pinnedMessages.length > 0 && (
          <div className="pinned-bar">
            <div className="pinned-bar-title">Pinned ({pinnedMessages.length})</div>
            {pinnedMessages.map((m) => (
              <div
                key={m.id}
                className="pinned-bar-item"
                onClick={() => scrollToMessage(m.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") scrollToMessage(m.id);
                }}
              >
                <span className="pinned-bar-role">{m.role === "user" ? "You" : "Agent"}</span>
                <span className="pinned-bar-snippet">
                  {m.text.slice(0, 80)}{m.text.length > 80 ? "…" : ""}
                </span>
                <button
                  className="pinned-bar-unpin"
                  onClick={(e) => { e.stopPropagation(); togglePin(m.id); }}
                  title="Unpin"
                  aria-label="Unpin message"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {error && <p className="error-text">{error}</p>}

        {/* Edit banner */}
        {editingMsg && (
          <div className="edit-banner">
            <span>Editing message</span>
            <button className="edit-banner-cancel" onClick={cancelEdit} title="Cancel edit">
              Cancel
            </button>
          </div>
        )}

        {/* Composer */}
        <div className="composer">
          <div className="composer-inner">
            <textarea
              ref={textareaRef}
              rows={1}
              placeholder={
                editingMsg
                  ? "Edit your message… (Esc to cancel)"
                  : "Message…"
              }
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={busy}
              aria-label="Message input"
              className="composer-textarea"
            />
            <div className="composer-actions">
              {busy ? (
                <button
                  className="composer-stop-btn"
                  onClick={() => void handleStop()}
                  title="Stop generation"
                  aria-label="Stop generation"
                >
                  &#9632;
                </button>
              ) : (
                <button
                  className="composer-send-btn"
                  disabled={!input.trim()}
                  onClick={() => void handleSend()}
                  aria-label={editingMsg ? "Update message" : "Send message"}
                >
                  {editingMsg ? "Update" : "Send"}
                </button>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Right sidebar — status */}
      <aside className="status-sidebar">
        <ContextMeter
          usedTokens={usedTokens}
          contextLimit={contextLimit}
          pct={contextPct}
          breakdown={breakdown}
        />
        <ReportPreview
          sessionId={sessionId}
          markdown={reportMarkdown}
          onRefresh={() => void refreshReport()}
        />
        <TodoPanel todos={todos} />
      </aside>
    </div>
  );
}
