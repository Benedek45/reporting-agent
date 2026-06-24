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
  RoadmapState,
} from "@/types";
import DocumentsSidebar from "@/app/_components/DocumentsSidebar";
import Thinking from "@/app/_components/Thinking";
import ContextMeter from "@/app/_components/ContextMeter";
import TodoPanel from "@/app/_components/TodoPanel";
import MarkdownMessage, { cleanVisibleReply } from "@/app/_components/MarkdownMessage";
import ToolActivity from "@/app/_components/ToolActivity";
import ThemeToggle from "@/app/_components/ThemeToggle";
import ReportPreview from "@/app/_components/ReportPreview";
import RoadmapBar from "@/app/_components/RoadmapBar";
import FileEditorModal from "@/app/_components/FileEditorModal";
import React from "react";

// Fallback shown when an assistant turn produced tool work but no visible
// text (a known intermittent local-model behaviour — e.g. Qwen reads files
// and writes the report but skips the summary sentence). Without this the
// user sees a blank bubble and assumes the agent "stopped".
function emptyAssistantFallback(tools: ToolEvent[]): string {
  const names = new Set(tools.map((t) => t.name));
  if (names.has("write") || names.has("edit")) {
    return "Done — I've updated the report with that information.";
  }
  if (names.has("read") || names.has("glob") || names.has("grep")) {
    return "Done — I've reviewed the documents.";
  }
  if (names.size > 0) return "Done.";
  return "";
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface NotifyPayload {
  kind: "upload" | "replace" | "edit";
  files: { name: string; diff?: string }[];
}

interface UIMessage {
  /** Stable id — from history API or locally generated */
  id: string;
  /** opencode message id (for edit) — only set for history-loaded messages */
  ocId?: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: number;
  tools: ToolEvent[];
  pinned: boolean;
}

/** Short, user-facing label for an out-of-band workspace notification. */
function notifyBubbleText(n: NotifyPayload): string {
  const fresh = n.files.filter((f) => !f.diff).map((f) => f.name);
  const changed = n.files.filter((f) => f.diff).map((f) => f.name);
  if (n.kind === "edit") return `Edited ${n.files.map((f) => f.name).join(", ")}`;
  const parts: string[] = [];
  if (fresh.length) parts.push(`Uploaded ${fresh.join(", ")}`);
  if (changed.length) parts.push(`Updated ${changed.join(", ")}`);
  return parts.join(" · ") || "Workspace updated";
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

  // Roadmap progress (top bar)
  const [roadmap, setRoadmap] = useState<RoadmapState | null>(null);
  // Track previous doneSteps so we can emit a "Roadmap updated" chip only
  // when items are actually newly checked.
  const prevRoadmapDoneRef = useRef<number>(-1);

  // In-app file editor
  const [editingFile, setEditingFile] = useState<string | null>(null);

  // Scrollbar pin dot positions (pct of scrollHeight)
  const [pinPositions, setPinPositions] = useState<{ id: string; pct: number }[]>([]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const msgRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chatMessagesRef = useRef<HTMLDivElement>(null);
  // Out-of-band notification queue + a flag tracking whether a stream is active
  // (notifications fire as their own turns, queued behind any in-flight turn).
  const streamingRef = useRef(false);
  const notifyQueueRef = useRef<NotifyPayload[]>([]);
  // Polling interval for SSE reconnection: when the page loads while the engine
  // is still generating, we poll /live every 3s until the turn completes.
  const resumePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resumePollChipId = useRef<string>("");
  // Ref to the latest runStream so flushNotifyQueue never captures a stale closure.
  const runStreamRef = useRef<(body: {
    sessionId: string;
    text?: string;
    editMessageId?: string;
    loadFileName?: string;
    notify?: NotifyPayload;
  }) => Promise<void>>(async () => { /* placeholder, replaced after first render */ });

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  // Recalculate pin dot positions in the scrollbar
  useEffect(() => {
    const container = chatMessagesRef.current;
    if (!container) { setPinPositions([]); return; }
    const sh = container.scrollHeight;
    if (sh <= 0) { setPinPositions([]); return; }
    const containerRect = container.getBoundingClientRect();

    const positions: { id: string; pct: number }[] = [];
    for (const m of messages) {
      if (!pinnedIds.has(m.id)) continue;
      const el = msgRefs.current.get(m.id);
      if (!el) continue;
      // Compute true offset relative to the scroll container regardless of
      // intermediate positioned ancestors.
      const elRect = el.getBoundingClientRect();
      const trueTop = elRect.top - containerRect.top + container.scrollTop + el.offsetHeight / 2;
      const pct = (trueTop / sh) * 100;
      positions.push({ id: m.id, pct: Math.max(0, Math.min(100, pct)) });
    }
    setPinPositions(positions);
  }, [messages, pinnedIds]);

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
      const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}/state`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        usedTokens: number;
        contextLimit: number;
        pct: number;
        todos: TodoItem[];
        status: string;
        breakdown?: ContextBreakdownItem[];
        roadmap?: RoadmapState | null;
      };
      setUsedTokens(data.usedTokens);
      setContextLimit(data.contextLimit);
      setContextPct(data.pct);
      setTodos(data.todos);
      if (data.breakdown) setBreakdown(data.breakdown);
      if (data.roadmap !== undefined) {
        if (data.roadmap) prevRoadmapDoneRef.current = data.roadmap.doneSteps;
        setRoadmap(data.roadmap);
      }
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

  // Notify turns are submitted as user messages but render as system chips.
  // Roadmap-sync turns and their following assistant responses are hidden
  // entirely — progress feedback comes from the roadmap bar and a live
  // "Roadmap updated" chip emitted when doneSteps actually increases.
  const NOTIFY_PREFIX = "[Workspace update — not a user message]";
  const ROADMAP_SYNC_PREFIX = "[Roadmap sync — automated]";
  // The continuation prompt is auto-generated; hide the PROMPT but keep its
  // assistant reply (that reply is the whole point — the next interview question).
  const CONTINUE_PREFIX = "[Continue — automated]";

  // Map a history message to UIMessage, or null to skip it.
  const mapHistoryMessage = (
    m: MessageHistoryItem,
    i: number,
    arr: MessageHistoryItem[]
  ): UIMessage | null => {
    const isSync = m.role === "user" && m.text.startsWith(ROADMAP_SYNC_PREFIX);
    // Skip the sync prompt itself
    if (isSync) return null;
    // Skip the assistant response that immediately follows a sync prompt
    if (
      m.role === "assistant" &&
      i > 0 &&
      arr[i - 1].text.startsWith(ROADMAP_SYNC_PREFIX)
    ) {
      return null;
    }
    // Hide the auto-generated continuation PROMPT (its assistant reply stays).
    if (m.role === "user" && m.text.startsWith(CONTINUE_PREFIX)) return null;
    const isNotify = m.role === "user" && m.text.startsWith(NOTIFY_PREFIX);
    const chipText = isNotify
      ? m.text.slice(NOTIFY_PREFIX.length).trim().split("\n")[0].trim()
      : m.text;
    return {
      id: m.id,
      ocId: m.id,
      role: isNotify ? "system" : (m.role as UIMessage["role"]),
      text: isNotify ? chipText : m.text,
      createdAt: m.createdAt,
      tools: m.tools
        .map((t, idx) => ({
          id: `${m.id}-tool-${idx}`,
          name: t.name,
          status: (t.status as ToolEvent["status"]) ?? "completed",
          input: t.input,
          output: t.output,
        }))
        .filter((t) => t.status !== "error"),
      pinned: false,
    };
  };

  const refreshHistory = useCallback(async () => {
    try {
      const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}/messages`);
      if (!res.ok) return;
      const data = (await res.json()) as { messages: MessageHistoryItem[] };
      setMessages(
        data.messages.flatMap((m, i, arr) => {
          const mapped = mapHistoryMessage(m, i, arr);
          return mapped ? [mapped] : [];
        })
      );
    } catch {
      // Non-fatal
    }
  }, [sessionId]);

  // Load initial state on mount
  useEffect(() => {
    void refreshFiles();
    void refreshState();
    void refreshReport();

    // Load history; if empty, show welcome from sessionStorage.
    // After loading, poll `/live` to detect if the engine is still running
    // (page was refreshed mid-turn), and resume when it finishes.
    fetch(`/api/session/${encodeURIComponent(sessionId)}/messages`)
      .then((r) => (r.ok ? r.json() : null))
      .then(async (data: { messages: MessageHistoryItem[] } | null) => {
        let hasHistory = false;
        if (data && data.messages.length > 0) {
          hasHistory = true;
          setMessages(
            data.messages.flatMap((m, i, arr) => {
              const mapped = mapHistoryMessage(m, i, arr);
              return mapped ? [mapped] : [];
            })
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

        if (!hasHistory) return;

        // Check if the engine is still generating on this session.
        try {
          const liveRes = await fetch(
            `/api/session/${encodeURIComponent(sessionId)}/live`
          );
          if (!liveRes.ok) return;
          const live: { busy: boolean } = await liveRes.json();
          if (!live.busy) return;

          // Engine is busy — show a "Resuming" chip and poll every 3s.
          const chipId = generateId();
          resumePollChipId.current = chipId;
          setMessages((prev) => [
            ...prev,
            {
              id: chipId,
              role: "system",
              text: "Resuming — the agent is still working…",
              createdAt: Date.now(),
              tools: [],
              pinned: false,
            },
          ]);

          const poll = setInterval(async () => {
            try {
              const r = await fetch(
                `/api/session/${encodeURIComponent(sessionId)}/live`
              );
              if (!r.ok) {
                clearInterval(poll);
                return;
              }
              const l: { busy: boolean } = await r.json();
              if (!l.busy) {
                clearInterval(poll);
                resumePollRef.current = null;
                // Remove the chip and reload history
                setMessages((prev) => prev.filter((m) => m.id !== chipId));
                void refreshHistory();
              }
            } catch {
              // Retry next interval
            }
          }, 3000);
          resumePollRef.current = poll;
        } catch {
          // Non-fatal — /live may not be available yet
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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (resumePollRef.current) clearInterval(resumePollRef.current);
    };
  }, []);

  // ── Core stream function ───────────────────────────────────────────────────
  // IMPORTANT: callers must set streamingRef.current = true BEFORE calling this
  // function to prevent the race where two callers both pass the guard check.

  const runStream = useCallback(async (body: {
    sessionId: string;
    text?: string;
    editMessageId?: string;
    loadFileName?: string;
    notify?: NotifyPayload;
  }) => {
    // streamingRef.current is already true — set by the caller before invoking us.
    setBusy(true);
    setStreamingText("");
    setStreamingTools([]);
    setReasoningText("");
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

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

      reader = res.body.getReader();
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

            case "roadmap":
              if (
                prevRoadmapDoneRef.current >= 0 &&
                event.roadmap.doneSteps > prevRoadmapDoneRef.current
              ) {
                setMessages((prev) => [
                  ...prev,
                  {
                    id: generateId(),
                    role: "system",
                    text: "Roadmap updated",
                    createdAt: Date.now(),
                    tools: [],
                    pinned: false,
                  },
                ]);
              }
              prevRoadmapDoneRef.current = event.roadmap.doneSteps;
              setRoadmap(event.roadmap);
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
      if ((err as { name?: string }).name === "AbortError") {
        reader?.cancel().catch(() => { /* ignore */ });
        return;
      }
      setError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setStreamingText(null);
      setStreamingTools([]);
      setReasoningText("");
      setBusy(false);
      // Reset the streaming flag BEFORE flushing the queue so the next item
      // can acquire the lock.
      streamingRef.current = false;
      abortRef.current = null;
      // A turn just ended — fire the next queued workspace notification, if any.
      // Use the ref so we always call the latest version of flushNotifyQueue.
      const next = notifyQueueRef.current.shift();
      if (next) {
        // Acquire the lock synchronously before any await.
        streamingRef.current = true;
        setMessages((prev) => [
          ...prev,
          {
            id: generateId(),
            role: "system",
            text: notifyBubbleText(next),
            createdAt: Date.now(),
            tools: [],
            pinned: false,
          },
        ]);
        void runStreamRef.current({ sessionId: body.sessionId, notify: next });
      }
    }
  }, [refreshFiles, refreshState, refreshReport]);

  // Keep the ref in sync with the latest callback so flushNotifyQueue and
  // enqueueNotify always call the current version.
  useEffect(() => {
    runStreamRef.current = runStream;
  }, [runStream]);

  // ── Out-of-band notifications (upload / edit) ──────────────────────────────
  // Each fires as its OWN agent turn (not bound to a user prompt). If a turn is
  // already running, the notification is queued and fired when it completes.

  const flushNotifyQueue = useCallback(() => {
    // Guard: acquire the lock synchronously. If already streaming, the finally
    // block in runStream will drain the queue when the current turn ends.
    if (streamingRef.current) return;
    const next = notifyQueueRef.current.shift();
    if (!next) return;

    // Acquire the lock synchronously before any async work.
    streamingRef.current = true;
    setMessages((prev) => [
      ...prev,
      {
        id: generateId(),
        role: "system",
        text: notifyBubbleText(next),
        createdAt: Date.now(),
        tools: [],
        pinned: false,
      },
    ]);

    void runStreamRef.current({ sessionId, notify: next });
  }, [sessionId]);

  function enqueueNotify(payload: NotifyPayload) {
    notifyQueueRef.current.push(payload);
    flushNotifyQueue();
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

      // Acquire the streaming lock synchronously before any await.
      streamingRef.current = true;
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

      // Acquire the streaming lock synchronously before any await.
      streamingRef.current = true;
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

    // Acquire the streaming lock synchronously before any await.
    streamingRef.current = true;
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
  // pinnedIds is the single source of truth. message.pinned is derived at render
  // from pinnedIds so the two can never drift.

  function togglePin(id: string) {
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="chat-page-layout">
      {/* Left sidebar — documents */}
      <DocumentsSidebar
        sessionId={sessionId}
        files={files}
        onFilesChanged={() => void refreshFiles()}
        onStreamAction={(opts) => handleStreamAction(opts)}
        onNotify={(payload) => enqueueNotify(payload)}
        onEditFile={(name) => setEditingFile(name)}
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

        <RoadmapBar roadmap={roadmap} />

        <div className="chat-messages-wrapper">
        <div className="chat-messages" ref={chatMessagesRef}>
          {messages.length === 0 && !busy && (
            <p className="status-text">
              The agent will begin the interview once you send your first message.
            </p>
          )}

          {messages.map((msg) => {
            // Derive pinned from the single source of truth (pinnedIds set).
            const isPinned = pinnedIds.has(msg.id);
            return msg.role === "system" ? (
              <div
                key={msg.id}
                className="msg-system"
                ref={(el) => {
                  if (el) msgRefs.current.set(msg.id, el);
                  else msgRefs.current.delete(msg.id);
                }}
              >
                {msg.text}
              </div>
            ) : (
            <div
              key={msg.id}
              className={`msg-wrapper ${msg.role}`}
              ref={(el) => {
                if (el) msgRefs.current.set(msg.id, el);
                else msgRefs.current.delete(msg.id);
              }}
            >
              {/* Tool activity (assistant only, before the text) */}
              {msg.role === "assistant" && msg.tools.length > 0 && (
                <ToolActivity tools={msg.tools} />
              )}

              <div className={`msg ${msg.role}`}>
                {msg.role === "assistant" ? (
                  cleanVisibleReply(msg.text).trim() ? (
                    <MarkdownMessage content={msg.text} />
                  ) : (
                    <span className="msg-fallback">
                      {emptyAssistantFallback(msg.tools)}
                    </span>
                  )
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
                  className={`msg-pin-btn${isPinned ? " pinned" : ""}`}
                  onClick={() => togglePin(msg.id)}
                  title={isPinned ? "Unpin" : "Pin message"}
                  aria-label={isPinned ? "Unpin message" : "Pin message"}
                >
                  {isPinned ? "📌" : "📍"}
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
          );
          })}

          {/* In-progress streaming bubble. Planning before <reply> is hidden, so
              we render the bubble only when the CLEANED text is non-empty; while it
              is empty the Thinking indicator shows instead of a raw planning dump. */}
          {(() => {
            const visibleStreaming =
              streamingText === null ? "" : cleanVisibleReply(streamingText, true);
            return (
              <>
                {streamingText !== null &&
                  (visibleStreaming || streamingTools.length > 0) && (
                    <div className="msg-wrapper assistant">
                      {streamingTools.length > 0 && (
                        <ToolActivity tools={streamingTools} />
                      )}
                      {visibleStreaming ? (
                        <div className="msg assistant msg-streaming">
                          <MarkdownMessage content={streamingText} streaming />
                        </div>
                      ) : null}
                    </div>
                  )}

                {/* Thinking indicator — the ONLY bubble while waiting for a visible reply */}
                <Thinking
                  active={busy && !visibleStreaming}
                  reasoning={reasoningText}
                  label={streamingTools.length > 0 ? "Working on it..." : "Thinking"}
                />
              </>
            );
          })()}

          <div ref={messagesEndRef} />
        </div>

        {/* Scrollbar pin dots */}
        {pinPositions.length > 0 && (
          <div className="pin-dots-track" aria-hidden="true">
            {pinPositions.map((p) => (
              <button
                key={p.id}
                className="pin-dot"
                style={{ top: `${p.pct}%` }}
                onClick={() => scrollToMessage(p.id)}
                title="Jump to pinned message"
                tabIndex={-1}
              />
            ))}
          </div>
        )}
        </div>{/* end chat-messages-wrapper */}

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

      {/* In-app file editor */}
      {editingFile && (
        <FileEditorModal
          sessionId={sessionId}
          fileName={editingFile}
          onClose={() => setEditingFile(null)}
          onSaved={(name, diff) => {
            setEditingFile(null);
            enqueueNotify({ kind: "edit", files: [{ name, diff }] });
            void refreshFiles();
          }}
          onError={(msg) => setError(msg)}
        />
      )}
    </div>
  );
}
