"use client";

import type { TodoItem } from "@/types";

interface TodoPanelProps {
  todos: TodoItem[];
}

const STATUS_ICONS: Record<string, string> = {
  pending: "○",
  in_progress: "◑",
  completed: "●",
  cancelled: "✕",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Done",
  cancelled: "Cancelled",
};

const PRIORITY_LABELS: Record<string, string> = {
  high: "High",
  medium: "Med",
  low: "Low",
};

export default function TodoPanel({ todos }: TodoPanelProps) {
  if (todos.length === 0) {
    return (
      <div className="todo-panel">
        <div className="todo-panel-title">Tasks</div>
        <p className="todo-empty">No tasks yet.</p>
      </div>
    );
  }

  return (
    <div className="todo-panel">
      <div className="todo-panel-title">Tasks</div>
      <ul className="todo-list">
        {todos.map((todo, i) => {
          const icon = STATUS_ICONS[todo.status] ?? "○";
          const statusLabel = STATUS_LABELS[todo.status] ?? todo.status;
          const priorityLabel = PRIORITY_LABELS[todo.priority] ?? todo.priority;
          // Use content as a stable key (titles are unique per todo list).
          // Fall back to index only if content is somehow empty.
          const stableKey = todo.content || String(i);

          return (
            <li
              key={stableKey}
              className={`todo-item todo-status-${todo.status}`}
              title={`${statusLabel} · Priority: ${priorityLabel}`}
            >
              <span className="todo-icon" aria-label={statusLabel}>{icon}</span>
              <span className="todo-content">{todo.content}</span>
              {todo.priority && todo.priority !== "medium" && (
                <span className={`todo-priority todo-priority-${todo.priority}`}>
                  {priorityLabel}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
