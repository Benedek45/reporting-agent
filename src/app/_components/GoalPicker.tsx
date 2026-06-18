"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface GoalOption {
  id: string;
  title: string;
}

interface GoalPickerProps {
  goals: GoalOption[];
}

export default function GoalPicker({ goals }: GoalPickerProps) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string>(
    goals.length > 0 ? goals[0].id : ""
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleStart() {
    if (!selectedId) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goalId: selectedId }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `Server error ${res.status}`);
      }

      const data = (await res.json()) as { sessionId: string; welcome?: string };

      // Stash the welcome message so the chat page can show it immediately
      if (data.welcome) {
        try {
          sessionStorage.setItem(`welcome:${data.sessionId}`, data.welcome);
        } catch {
          // sessionStorage unavailable — non-fatal
        }
      }

      router.push(`/chat/${data.sessionId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
      setLoading(false);
    }
  }

  if (goals.length === 0) {
    return <p>No goals configured. Add a Markdown file to the goals/ folder.</p>;
  }

  return (
    <div className="card goal-card">
      <div className="home-section-heading">
        <span>Choose a goal</span>
        <small>Pick the workflow the agent should run.</small>
      </div>
      <div className="goal-picker-row">
        <select
          id="goal-select"
          className="goal-select"
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          disabled={loading}
        >
          {goals.map((g) => (
            <option key={g.id} value={g.id}>
              {g.title}
            </option>
          ))}
        </select>
        <button
          className="btn btn-primary"
          onClick={handleStart}
          disabled={loading || !selectedId}
        >
          {loading ? "Starting…" : "Start"}
        </button>
      </div>
      {error && (
        <p className="error-text">
          {error}
        </p>
      )}
    </div>
  );
}
