"use client";

interface ContextMeterProps {
  usedTokens: number;
  contextLimit: number;
  pct: number;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function ContextMeter({ usedTokens, contextLimit, pct }: ContextMeterProps) {
  const clampedPct = Math.min(100, Math.max(0, pct));
  const isWarning = clampedPct >= 75;
  const isDanger = clampedPct >= 90;

  return (
    <div className="context-meter">
      <div className="context-meter-header">
        <span className="context-meter-label">Context used</span>
        <span className={`context-meter-pct${isDanger ? " danger" : isWarning ? " warning" : ""}`}>
          {clampedPct.toFixed(0)}%
        </span>
      </div>
      <div className="context-meter-bar-track" role="progressbar" aria-valuenow={clampedPct} aria-valuemin={0} aria-valuemax={100}>
        <div
          className={`context-meter-bar-fill${isDanger ? " danger" : isWarning ? " warning" : ""}`}
          style={{ width: `${clampedPct}%` }}
        />
      </div>
      <div className="context-meter-tokens">
        {formatTokens(usedTokens)} / {formatTokens(contextLimit)} tokens
      </div>
    </div>
  );
}
