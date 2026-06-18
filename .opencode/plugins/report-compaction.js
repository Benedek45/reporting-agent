// report-compaction.js — reporting-agent context-management plugin
//
// License: MIT (part of reporting-agent; NOT the AGPL DCP plugin).
//
// Purpose: opencode runs native compaction when a session nears its context
// limit. Default compaction is generic and can drop the exact things a
// compliance/ESG report engagement must never lose. This plugin hooks
// `experimental.session.compacting` and injects domain-critical state into the
// compaction summary so it survives:
//   - the active goal/framework (goal.md),
//   - the report STATUS checklist and every open [DATA NEEDED: ...] item,
//   - figures already collected and their source attributions,
//   - which documents have been provided vs. are outstanding.
//
// It resolves the session's workspace from the same `.sessions/<id>` mapping the
// BFF writes (see src/lib/workspace.ts), using only Node built-ins so it loads
// even though /config is mounted read-only.

import { readFile } from "node:fs/promises"
import path from "node:path"

const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT || "/workspaces"

function sanitize(name) {
  return path.basename(String(name)).replace(/[/\\]/g, "_")
}

async function resolveWorkspace(sessionID) {
  const mapPath = path.join(WORKSPACES_ROOT, ".sessions", sanitize(sessionID))
  let raw
  try {
    raw = await readFile(mapPath, "utf8")
  } catch {
    return null
  }
  raw = raw.trim()
  // The state file is JSON ({ workspaceId, messageCount, uploads, ... }).
  // Older sessions wrote a bare UUID string. Handle both.
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed.workspaceId === "string") {
        return path.join(WORKSPACES_ROOT, sanitize(parsed.workspaceId))
      }
    } catch {
      return null
    }
  }
  return path.join(WORKSPACES_ROOT, sanitize(raw))
}

function extractStatus(report) {
  const block = report.match(/<!--\s*STATUS[\s\S]*?-->/)
  if (block) return block[0]
  const gaps = report.split(/\r?\n/).filter((line) => line.includes("[DATA NEEDED"))
  return gaps.length ? "Open data gaps:\n" + gaps.slice(0, 50).join("\n") : ""
}

const STATIC_GUIDANCE = [
  "## Reporting engagement — preserve across compaction",
  "This is a compliance / ESG report-drafting session. When you summarize, you MUST keep:",
  "- The active goal and reporting framework (see goal.md).",
  "- The report's STATUS checklist and EVERY open `[DATA NEEDED: ...]` item — do not drop any.",
  "- Every figure already collected together with its source attribution (file + location).",
  "- Which documents the user has provided, and what is still outstanding.",
  "- Any materiality decisions and which topical standards were judged material.",
  "Never fabricate data; anything missing stays as `[DATA NEEDED: ...]`.",
].join("\n")

export const ReportCompaction = async () => ({
  "experimental.session.compacting": async (input, output) => {
    output.context.push(STATIC_GUIDANCE)

    try {
      const ws = await resolveWorkspace(input.sessionID)
      if (!ws) return

      const [goal, report, agents] = await Promise.allSettled([
        readFile(path.join(ws, "goal.md"), "utf8"),
        readFile(path.join(ws, "output", "report.md"), "utf8"),
        readFile(path.join(ws, "AGENTS.md"), "utf8"),
      ])

      if (goal.status === "fulfilled" && goal.value.trim()) {
        output.context.push("## Active goal (goal.md)\n" + goal.value.trim().slice(0, 2000))
      }

      if (agents.status === "fulfilled" && agents.value.trim()) {
        // The user's per-chat memory file (like Claude.md) — re-inject after
        // compaction so it survives as long-term context. Skip the empty stub.
        const text = agents.value.trim()
        const isStub =
          text.startsWith("# Engagement notes") &&
          text.includes("Write house style, formatting, or per-engagement instructions")
        if (!isStub) {
          output.context.push("## Engagement notes (agents.md — user's long-term memory)\n" + text.slice(0, 6000))
        }
      }

      if (report.status === "fulfilled" && report.value.trim()) {
        const status = extractStatus(report.value)
        if (status) {
          output.context.push("## Current report status (output/report.md)\n" + status.slice(0, 4000))
        }
      }
    } catch {
      // Best-effort enrichment; the static guidance above always applies.
    }
  },
})
