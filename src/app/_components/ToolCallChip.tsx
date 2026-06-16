"use client";

import { useState } from "react";
import type { ToolEvent } from "@/types";

const TOOL_LABELS: Record<string, string> = {
  read_file: "Read file",
  write_file: "Write file",
  list_directory: "List directory",
  search_files: "Search files",
  bash: "Run command",
  web_search: "Web search",
  web_fetch: "Fetch URL",
  skill: "Load skill",
  task: "Spawn subagent",
  delete_file: "Delete file",
  workspace_delete_file: "Delete file",
  todowrite: "Update tasks",
  todoread: "Read tasks",
};

function friendlyName(name: string): string {
  return TOOL_LABELS[name] ?? name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

interface ToolCallChipProps {
  tool: ToolEvent;
}

export default function ToolCallChip({ tool }: ToolCallChipProps) {
  const [expanded, setExpanded] = useState(false);

  // Never surface raw errors to non-technical users
  if (tool.status === "error") return null;

  const hasDetails = tool.input !== undefined || tool.output !== undefined;

  const statusLabel =
    tool.status === "pending" ? "pending"
    : tool.status === "running" ? "running…"
    : "done";

  return (
    <div className="tool-chip">
      <div
        className="tool-chip-header"
        onClick={() => hasDetails && setExpanded((v) => !v)}
        role={hasDetails ? "button" : undefined}
        tabIndex={hasDetails ? 0 : undefined}
        onKeyDown={(e) => {
          if (hasDetails && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        aria-expanded={hasDetails ? expanded : undefined}
      >
        <span className={`tool-status-dot ${tool.status}`} aria-hidden="true" />
        <span className="tool-chip-name">{tool.title ?? friendlyName(tool.name)}</span>
        <span className="tool-chip-status-label">{statusLabel}</span>
        {hasDetails && (
          <span className="tool-chip-toggle">{expanded ? "▲" : "▼"}</span>
        )}
      </div>

      {expanded && hasDetails && (
        <div className="tool-chip-body">
          {tool.input !== undefined && (
            <>
              <span className="tool-chip-section-label">Input</span>
              <pre className="tool-chip-pre">{formatValue(tool.input)}</pre>
            </>
          )}
          {tool.output !== undefined && (
            <>
              <span className="tool-chip-section-label">Output</span>
              <pre className="tool-chip-pre">{tool.output}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
