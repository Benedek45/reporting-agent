"use client";

import { useMemo, useState } from "react";
import type { ToolEvent } from "@/types";
import ToolCallChip from "./ToolCallChip";

const TOOL_LABELS: Record<string, string> = {
  read_file: "read files",
  write_file: "wrote files",
  list_directory: "checked files",
  search_files: "searched files",
  bash: "ran command",
  web_search: "searched web",
  web_fetch: "opened sources",
  skill: "loaded guidance",
  task: "used subagent",
  delete_file: "deleted file",
  workspace_delete_file: "deleted file",
  todowrite: "updated tasks",
  todoread: "checked tasks",
  time_get_current_time: "checked time",
  "fact-check_verify_claim": "fact-checked",
};

function friendlyName(name: string): string {
  return TOOL_LABELS[name] ?? name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function summarizeTools(tools: ToolEvent[]): string {
  const unique = Array.from(new Set(tools.map((tool) => friendlyName(tool.name))));
  if (unique.length === 0) return "Used tools";
  if (unique.length <= 2) return unique.join(" and ");
  return `${unique.slice(0, 2).join(", ")} + ${unique.length - 2} more`;
}

interface ToolActivityProps {
  tools: ToolEvent[];
}

export default function ToolActivity({ tools }: ToolActivityProps) {
  const [expanded, setExpanded] = useState(false);
  const visibleTools = useMemo(
    () => tools.filter((tool) => tool.status !== "error"),
    [tools]
  );

  if (visibleTools.length === 0) return null;

  const running = visibleTools.some((tool) => tool.status === "running" || tool.status === "pending");
  const completed = visibleTools.every((tool) => tool.status === "completed");
  const summary = running
    ? `Working with ${summarizeTools(visibleTools)}`
    : summarizeTools(visibleTools);
  const status = running ? "working" : completed ? "done" : "updated";

  return (
    <div className="tool-activity">
      <button
        className="tool-activity-summary"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        type="button"
      >
        <span className={`tool-activity-dot ${running ? "running" : "completed"}`} aria-hidden="true" />
        <span className="tool-activity-text">{summary}</span>
        <span className="tool-activity-status">{status}</span>
        <span className="tool-activity-toggle" aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
      </button>

      {expanded && (
        <div className="tool-activity-details">
          {visibleTools.map((tool) => (
            <ToolCallChip key={tool.id} tool={tool} />
          ))}
        </div>
      )}
    </div>
  );
}
