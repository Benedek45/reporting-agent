"use client";

import { useEffect, useRef, useState } from "react";

interface ThinkingProps {
  active: boolean;
  reasoning?: string;
  label?: string;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export default function Thinking({ active, reasoning, label = "Thinking" }: ThinkingProps) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (active) {
      startRef.current = Date.now();
      setElapsed(0);

      const tick = () => {
        if (startRef.current !== null) {
          setElapsed(Date.now() - startRef.current);
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } else {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      startRef.current = null;
      setElapsed(0);
    }

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [active]);

  if (!active) return null;

  return (
    <div className="thinking-indicator" aria-live="polite" aria-label="Agent is thinking">
      <div className="thinking-row">
        <span className="thinking-dots">
          <span />
          <span />
          <span />
        </span>
        <span className="thinking-label">{label}</span>
        <span className="thinking-timer">{formatElapsed(elapsed)}</span>
      </div>
      {reasoning ? <div className="thinking-reasoning">{reasoning}</div> : null}
    </div>
  );
}
