"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ALL_TASKS } from "@/lib/tasks";
import type { TaskId } from "@/types";

export default function HomePage() {
  const router = useRouter();
  const [loading, setLoading] = useState<TaskId | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleStart(taskId: TaskId) {
    setLoading(taskId);
    setError(null);

    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `Server error ${res.status}`);
      }

      const data = (await res.json()) as { sessionId: string };
      router.push(`/chat/${data.sessionId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
      setLoading(null);
    }
  }

  return (
    <main>
      <h1>Reporting Agent</h1>
      <p>Select a report type to begin. The AI will interview you and draft the report.</p>

      {error && <p className="error-text" style={{ marginTop: "1rem" }}>{error}</p>}

      <div className="card-grid">
        {ALL_TASKS.map((task) => (
          <div key={task.id} className="card">
            <h2>{task.label}</h2>
            <p>{task.blurb}</p>
            <button
              className="btn btn-primary"
              disabled={loading !== null}
              onClick={() => handleStart(task.id)}
            >
              {loading === task.id ? "Starting…" : "Start"}
            </button>
          </div>
        ))}
      </div>
    </main>
  );
}
