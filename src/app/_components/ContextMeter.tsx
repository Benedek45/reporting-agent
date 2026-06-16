"use client";

import type { ContextBreakdownItem } from "@/types";

interface ContextMeterProps {
  usedTokens: number;
  contextLimit: number;
  pct: number;
  breakdown?: ContextBreakdownItem[];
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// Segment colors for breakdown categories
const SEGMENT_COLORS = ["#0d6efd", "#6f42c1", "#e67e22", "#198754"];

export default function ContextMeter({
  usedTokens,
  contextLimit,
  pct,
  breakdown,
}: ContextMeterProps) {
  const clampedPct = Math.min(100, Math.max(0, pct));
  const isWarning = clampedPct >= 75;
  const isDanger = clampedPct >= 90;

  const hasBreakdown = breakdown && breakdown.length > 0 && contextLimit > 0;

  return (
    <div className="context-meter">
      <div className="context-meter-header">
        <span className="context-meter-label">Context used</span>
        <span
          className={`context-meter-pct${isDanger ? " danger" : isWarning ? " warning" : ""}`}
        >
          {clampedPct.toFixed(0)}%
        </span>
      </div>

      {/* Single bar: segmented when breakdown available, solid otherwise */}
      <div
        className="context-meter-bar-track"
        role="progressbar"
        aria-valuenow={clampedPct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        {hasBreakdown ? (
          breakdown!.map((item, i) => {
            const segPct = Math.min(100, (item.tokens / contextLimit) * 100);
            return (
              <div
                key={item.label}
                className="context-breakdown-segment"
                style={{
                  width: `${segPct}%`,
                  background: SEGMENT_COLORS[i % SEGMENT_COLORS.length],
                }}
              />
            );
          })
        ) : (
          <div
            className={`context-meter-bar-fill${isDanger ? " danger" : isWarning ? " warning" : ""}`}
            style={{ width: `${clampedPct}%` }}
          />
        )}
      </div>

      <div className="context-meter-tokens">
        {formatTokens(usedTokens)} / {formatTokens(contextLimit)} tokens
      </div>

      {/* Legend */}
      {hasBreakdown && (
        <>
          <div className="context-breakdown-legend">
            {breakdown!.map((item, i) => {
              const segPct =
                contextLimit > 0
                  ? ((item.tokens / contextLimit) * 100).toFixed(1)
                  : "0.0";
              return (
                <div key={item.label} className="context-breakdown-row">
                  <span
                    className="context-breakdown-dot"
                    style={{ background: SEGMENT_COLORS[i % SEGMENT_COLORS.length] }}
                  />
                  <span className="context-breakdown-row-label">{item.label}</span>
                  <span className="context-breakdown-row-tokens">
                    {formatTokens(item.tokens)} ({segPct}%)
                  </span>
                </div>
              );
            })}
          </div>

          <div className="context-meter-approx">approximate</div>
        </>
      )}
    </div>
  );
}
