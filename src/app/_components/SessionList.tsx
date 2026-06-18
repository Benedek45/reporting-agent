"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export interface SessionSummary {
  id: string;
  title: string;
  goalHint: string | null;
  lastActivityMs: number;
  createdMs: number;
  messageCount: number;
  roadmapPct: number | null;
}

interface SessionListProps {
  /** Initial list rendered server-side; refreshed on mount + after delete. */
  initial: SessionSummary[];
}

/**
 * Renders a compact list of previous chats on the home page. Each row shows
 * the title, the goal hint (if known), last activity (relative time),
 * message count, and a small roadmap-% badge. Clicking a row opens the
 * chat; clicking delete prompts a confirm and removes the session entirely
 * (workspace + engine entry).
 */
export default function SessionList({ initial }: SessionListProps) {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionSummary[]>(initial);
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/sessions", { cache: "no-store" });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const data = (await res.json()) as { sessions: SessionSummary[] };
      setSessions(data.sessions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load sessions");
    } finally {
      setLoading(false);
    }
  }, []);

  // Refresh on mount in case the server-rendered list is stale
  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleDelete = useCallback(
    async (id: string, title: string) => {
      const ok = window.confirm(
        `Delete this chat and all its files?\n\n"${title}"\n\nThis cannot be undone.`
      );
      if (!ok) return;
      setDeletingId(id);
      setError(null);
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        if (!res.ok && res.status !== 204) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? `Server error ${res.status}`);
        }
        setSessions((prev) => prev.filter((s) => s.id !== id));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not delete");
      } finally {
        setDeletingId(null);
      }
    },
    []
  );

  if (sessions.length === 0 && !loading && !error) {
    return (
      <div className="card session-list-empty">
        <p>No previous chats yet. Start one above to begin.</p>
      </div>
    );
  }

  return (
    <div className="card session-list-card">
      <div className="session-list-header">
        <strong>Previous chats</strong>
        <button
          type="button"
          className="session-list-refresh"
          onClick={refresh}
          disabled={loading}
          aria-label="Refresh chat list"
        >
          {loading ? "Refreshing…" : "↻"}
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
      <ul className="session-list">
        {sessions.map((s) => (
          <li key={s.id} className="session-list-item">
            <button
              type="button"
              className="session-list-open"
              onClick={() => router.push(`/chat/${encodeURIComponent(s.id)}`)}
              title="Open this chat"
            >
              <div className="session-list-title">
                {s.title}
                {s.goalHint && (
                  <span className="session-list-goal">{s.goalHint}</span>
                )}
              </div>
              <div className="session-list-meta">
                <span className="session-list-time">
                  {formatRelative(s.lastActivityMs)}
                </span>
                <span className="session-list-msgs">
                  {s.messageCount} {s.messageCount === 1 ? "msg" : "msgs"}
                </span>
                {s.roadmapPct !== null && (
                  <span className="session-list-roadmap">
                    {s.roadmapPct}%
                  </span>
                )}
              </div>
            </button>
            <button
              type="button"
              className="session-list-delete"
              onClick={() => handleDelete(s.id, s.title)}
              disabled={deletingId === s.id}
              aria-label="Delete this chat"
              title="Delete chat and all files"
            >
              {deletingId === s.id ? "…" : "✕"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatRelative(ms: number): string {
  if (!ms) return "—";
  const now = Date.now();
  const delta = now - ms;
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month}mo ago`;
  const year = Math.floor(day / 365);
  return `${year}y ago`;
}
