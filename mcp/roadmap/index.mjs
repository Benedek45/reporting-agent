/**
 * roadmap MCP server — zero external dependencies.
 *
 * Launched by the opencode engine container with:
 *   bun run /config/mcp/roadmap/index.mjs
 *
 * The engine container runs oven/bun:1.3.14 (Linux). Node is NOT guaranteed
 * present, so this file uses only bun/node built-ins: node:fs, node:path,
 * node:readline. No npm packages.
 *
 * WHY THIS EXISTS: the per-session progress bar reads the CANONICAL checklist
 * at `<workspace>/roadmap.md` (workspace root), parsed as GitHub task-list
 * items (`- [ ]` / `- [x]`). Models (esp. Gemma 4) are unreliable at editing
 * that file in place: they write to the wrong folder (`output/roadmap.md`),
 * destructively rewrite it to a few summary items, or invent non-standard
 * syntax (`- [in_progress]`). This tool lets the agent NAME an item and have
 * the APP deterministically flip the correct checkbox in the canonical file —
 * no path confusion, no rewrites, no invalid syntax.
 *
 * Protocol: MCP JSON-RPC 2.0 over stdio (line-delimited JSON).
 * Handles: initialize, notifications/initialized, tools/list, tools/call.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

// ── constants ────────────────────────────────────────────────────────────────

const SERVER_INFO = { name: "roadmap", version: "0.0.1" };
const PROTOCOL_VERSION = "2024-11-05";

/** Safety boundary: this server only touches files under this prefix. */
const WORKSPACE_ROOT = "/workspaces/";

// ── tool definitions ─────────────────────────────────────────────────────────

const MARK_DONE_TOOL = {
  name: "mark_done",
  description:
    "Marks one or more roadmap checklist items as COMPLETE in the canonical " +
    "progress file (roadmap.md at the workspace root). This is the ONLY correct " +
    "way to update the progress bar — do NOT edit roadmap.md with the file editor. " +
    "WHEN TO USE: after you have collected a sourced figure/disclosure and folded " +
    "it into the report, mark the matching roadmap item(s) done. " +
    "HOW IT MATCHES: you pass short item descriptions; the server fuzzy-matches " +
    "each against the UNCHECKED items in roadmap.md and flips `- [ ]` to `- [x]`. " +
    "You do not need the exact wording — a close description works (call the " +
    "`roadmap_status` tool first if you want the exact labels). " +
    "ARGUMENTS: workspace_dir = the absolute path of your current working " +
    "directory (the workspace root, e.g. /workspaces/<id>); items = an array of " +
    "short item descriptions to mark complete. " +
    "RETURNS: which items were marked (with their full labels), which queries " +
    "matched nothing, and the new done/total counts. " +
    "It NEVER deletes, reorders, re-titles, or shortens items; it only flips " +
    "checkboxes. If a query matches no open item, it is reported as unmatched.",
  inputSchema: {
    type: "object",
    properties: {
      workspace_dir: {
        type: "string",
        description:
          "Absolute path of the workspace root (your current working directory), " +
          "e.g. /workspaces/<session-id>. A trailing '/output' is ignored. The " +
          "tool always targets <workspace_dir>/roadmap.md.",
      },
      items: {
        type: "array",
        items: { type: "string" },
        description:
          "Short descriptions of the checklist items to mark complete. Each is " +
          "fuzzy-matched against the unchecked items in roadmap.md. " +
          'Example: ["Scope 1 emissions", "Entity legal name and fiscal year"].',
      },
    },
    required: ["workspace_dir", "items"],
  },
};

const MARK_UNDONE_TOOL = {
  name: "mark_undone",
  description:
    "Marks one or more roadmap checklist items as NOT complete again (flips " +
    "`- [x]` back to `- []`) in the canonical progress file (roadmap.md at the " +
    "workspace root). This is the ONLY correct way to UNDO progress — do NOT edit " +
    "roadmap.md with the file editor. " +
    "WHEN TO USE: when an item you previously marked done turns out to be wrong — " +
    "e.g. the fact-checker found a contradiction in the figure, the source document " +
    "was deleted or replaced with conflicting data, or the user corrects/retracts " +
    "something they confirmed earlier. Re-open the affected item(s) so the progress " +
    "bar reflects reality. " +
    "HOW IT MATCHES: you pass short item descriptions; the server fuzzy-matches each " +
    "against the CHECKED (`- [x]`) items in roadmap.md and flips them back to open. " +
    "You do not need exact wording (call `roadmap_status` first to see labels). " +
    "ARGUMENTS: workspace_dir = the absolute path of your current working directory " +
    "(the workspace root, e.g. /workspaces/<id>); items = an array of short item " +
    "descriptions to re-open. " +
    "RETURNS: which items were re-opened (with full labels), which queries matched " +
    "no checked item, and the new done/total counts. It NEVER deletes, reorders, " +
    "re-titles, or shortens items; it only flips checkboxes.",
  inputSchema: {
    type: "object",
    properties: {
      workspace_dir: {
        type: "string",
        description:
          "Absolute path of the workspace root (your current working directory), " +
          "e.g. /workspaces/<session-id>. A trailing '/output' is ignored. The " +
          "tool always targets <workspace_dir>/roadmap.md.",
      },
      items: {
        type: "array",
        items: { type: "string" },
        description:
          "Short descriptions of the checklist items to re-open. Each is " +
          "fuzzy-matched against the CHECKED items in roadmap.md. " +
          'Example: ["Scope 1 emissions", "Water withdrawal"].',
      },
    },
    required: ["workspace_dir", "items"],
  },
};

const STATUS_TOOL = {
  name: "status",
  description:
    "Returns the current roadmap checklist (roadmap.md at the workspace root) " +
    "with each item's exact label and done/not-done state, grouped by section, " +
    "plus done/total counts. " +
    "WHEN TO USE: to see the exact item wording before calling `roadmap_mark_done`, " +
    "or to check overall progress. Read-only; never modifies the file. " +
    "ARGUMENT: workspace_dir = the absolute path of your current working directory " +
    "(the workspace root, e.g. /workspaces/<id>).",
  inputSchema: {
    type: "object",
    properties: {
      workspace_dir: {
        type: "string",
        description:
          "Absolute path of the workspace root (your current working directory), " +
          "e.g. /workspaces/<session-id>. A trailing '/output' is ignored.",
      },
    },
    required: ["workspace_dir"],
  },
};

// ── JSON-RPC helpers ─────────────────────────────────────────────────────────

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function toolResult(content, isError = false) {
  return { content, isError };
}

function textContent(text) {
  return [{ type: "text", text }];
}

function jsonResult(obj, isError = false) {
  return toolResult(textContent(JSON.stringify(obj)), isError);
}

// ── roadmap helpers ──────────────────────────────────────────────────────────

/**
 * Resolves the canonical roadmap.md path from a workspace_dir argument.
 * Accepts the workspace root, the workspace root with a trailing /output, or a
 * direct path to roadmap.md. Always returns <workspaceRoot>/roadmap.md.
 * Returns { path } on success or { error } if outside /workspaces.
 */
function resolveRoadmapPath(rawDir) {
  if (typeof rawDir !== "string" || rawDir.trim() === "") {
    return { error: "workspace_dir argument is required and must be a non-empty string" };
  }
  let resolved = path.resolve(rawDir);

  // If they passed the file itself, step up to its directory.
  if (path.basename(resolved) === "roadmap.md") {
    resolved = path.dirname(resolved);
  }
  // If they passed the output/ subfolder, step up to the workspace root.
  if (path.basename(resolved) === "output") {
    resolved = path.dirname(resolved);
  }

  if (!resolved.startsWith(WORKSPACE_ROOT)) {
    return {
      error: `Refused: '${resolved}' is outside the allowed workspace root '${WORKSPACE_ROOT}'.`,
    };
  }
  return { path: path.join(resolved, "roadmap.md") };
}

/** Normalizes a label for fuzzy comparison: lowercase, strip markdown/punct, collapse spaces. */
function normalizeLabel(label) {
  return String(label)
    .toLowerCase()
    .replace(/[*_`#>]/g, " ") // markdown emphasis / heading marks
    .replace(/[^a-z0-9\s]/g, " ") // punctuation
    .replace(/\s+/g, " ")
    .trim();
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "at", "by",
  "with", "from", "is", "are", "be", "this", "that", "your", "their", "its",
  "data", "info", "information", "section",
]);

function tokenize(label) {
  return normalizeLabel(label)
    .split(" ")
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/**
 * Scores a query against a candidate label using the OVERLAP COEFFICIENT
 * (shared tokens / size of the SMALLER token set), plus a substring bonus.
 *
 * Why overlap, not recall-of-query: the agent often names an item with a
 * verbose, document-centric phrase ("supplier facility data 2024 with energy,
 * water, audit"). The old `shared / queryTokens.length` put that long query in
 * the denominator, so even a correct match scored far below threshold and the
 * checkbox was never flipped. The overlap coefficient is symmetric in length —
 * a long query that contains all of a concise checklist item's distinctive
 * tokens (or vice-versa) scores ~1.0 — so reasonable wording matches regardless
 * of how verbose either side is.
 *
 * Returns a number in [0, ~1.5]; higher is better.
 */
function matchScore(query, candidate) {
  const nq = normalizeLabel(query);
  const nc = normalizeLabel(candidate);
  if (!nq || !nc) return 0;
  if (nq === nc) return 2; // exact normalized match

  const qSet = new Set(tokenize(query));
  const cSet = new Set(tokenize(candidate));
  if (qSet.size === 0 || cSet.size === 0) return 0;

  let shared = 0;
  for (const t of cSet) if (qSet.has(t)) shared += 1;

  if (shared === 0) {
    // No token overlap — only a substring containment can rescue it.
    return nc.includes(nq) || nq.includes(nc) ? 0.6 : 0;
  }

  // Overlap coefficient: shared / size of the smaller token set.
  let score = shared / Math.min(qSet.size, cSet.size);

  // Substring bonus (either direction) — strong signal of intent.
  if (nc.includes(nq) || nq.includes(nc)) score += 0.5;

  return score;
}

const MATCH_THRESHOLD = 0.5;

/** Atomic write: temp file in the same dir, then rename. */
function atomicWrite(filePath, contents) {
  const tmp = filePath + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, contents, "utf8");
  fs.renameSync(tmp, filePath);
}

const TASK_RE = /^(\s*[-*]\s+\[)([ xX])(\]\s+)(.*)$/;

/** Parses roadmap text into { sections:[{title, steps:[{label,done}]}], total, done }. */
function parseRoadmap(text) {
  const lines = text.split("\n");
  const sections = [];
  let current = null;
  let total = 0;
  let done = 0;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const heading = /^#{1,6}\s+(.*)$/.exec(line.trim());
    if (heading) {
      current = { title: heading[1].trim(), steps: [] };
      sections.push(current);
      continue;
    }
    const task = TASK_RE.exec(line);
    if (task) {
      if (!current) {
        current = { title: "General", steps: [] };
        sections.push(current);
      }
      const isDone = task[2].toLowerCase() === "x";
      current.steps.push({ label: task[4].trim(), done: isDone });
      total += 1;
      if (isDone) done += 1;
    }
  }

  return {
    sections: sections.filter((s) => s.steps.length > 0),
    total,
    done,
  };
}

// ── tool handlers ────────────────────────────────────────────────────────────

function handleStatus(args) {
  const resolved = resolveRoadmapPath(args && args.workspace_dir);
  if (resolved.error) return jsonResult({ error: resolved.error }, true);

  let text;
  try {
    text = fs.readFileSync(resolved.path, "utf8");
  } catch {
    return jsonResult(
      { error: `roadmap.md not found at '${resolved.path}'.` },
      true
    );
  }

  const parsed = parseRoadmap(text);
  return jsonResult({
    total: parsed.total,
    done: parsed.done,
    remaining: parsed.total - parsed.done,
    pct: parsed.total === 0 ? 0 : Math.round((parsed.done / parsed.total) * 100),
    sections: parsed.sections.map((s) => ({
      title: s.title,
      items: s.steps.map((st) => ({ label: st.label, done: st.done })),
    })),
  });
}

/**
 * Shared engine for mark_done / mark_undone. When markDone is true it matches
 * UNCHECKED items and flips them to `- [x]`; when false it matches CHECKED items
 * and flips them back to `- [ ]`. Only ever flips checkboxes — never deletes,
 * reorders, re-titles, or shortens items. Each candidate line is used at most
 * once per call.
 */
function flipItems(args, markDone) {
  const resolved = resolveRoadmapPath(args && args.workspace_dir);
  if (resolved.error) return jsonResult({ error: resolved.error }, true);

  const items = args && args.items;
  if (!Array.isArray(items) || items.length === 0) {
    return jsonResult(
      { error: "items argument is required and must be a non-empty array of strings" },
      true
    );
  }

  let text;
  try {
    text = fs.readFileSync(resolved.path, "utf8");
  } catch {
    return jsonResult(
      { error: `roadmap.md not found at '${resolved.path}'.` },
      true
    );
  }

  const lines = text.split("\n");

  // Candidate task lines: when marking done, match OPEN items; when un-marking,
  // match DONE items. We fuzzy-match queries against these labels.
  const candidates = []; // { lineIdx, label }
  for (let i = 0; i < lines.length; i++) {
    const m = TASK_RE.exec(lines[i].replace(/\s+$/, ""));
    if (!m) continue;
    const isDone = m[2].toLowerCase() === "x";
    if (markDone ? !isDone : isDone) {
      candidates.push({ lineIdx: i, label: m[4].trim() });
    }
  }

  const changed = [];
  const unmatched = [];
  const usedLineIdx = new Set();
  const newChar = markDone ? "x" : " ";

  for (const query of items) {
    if (typeof query !== "string" || query.trim() === "") {
      unmatched.push(String(query));
      continue;
    }
    let best = null;
    let bestScore = 0;
    for (const c of candidates) {
      if (usedLineIdx.has(c.lineIdx)) continue;
      const score = matchScore(query, c.label);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best && bestScore >= MATCH_THRESHOLD) {
      usedLineIdx.add(best.lineIdx);
      // Flip the checkbox on that line, preserving indentation/bullet/label.
      const m = TASK_RE.exec(lines[best.lineIdx].replace(/\s+$/, ""));
      if (m) {
        lines[best.lineIdx] = `${m[1]}${newChar}${m[3]}${m[4]}`;
        changed.push(best.label);
      } else {
        unmatched.push(query);
      }
    } else {
      unmatched.push(query);
    }
  }

  if (changed.length > 0) {
    try {
      atomicWrite(resolved.path, lines.join("\n"));
    } catch (err) {
      return jsonResult(
        { error: `Failed to write roadmap.md: ${err.message}` },
        true
      );
    }
  }

  const after = parseRoadmap(lines.join("\n"));
  const result = {
    unmatched,
    done: after.done,
    total: after.total,
    remaining: after.total - after.done,
    pct: after.total === 0 ? 0 : Math.round((after.done / after.total) * 100),
  };
  // Keep the field name intuitive per direction.
  result[markDone ? "marked" : "unmarked"] = changed;
  return jsonResult(result);
}

function handleMarkDone(args) {
  return flipItems(args, true);
}

function handleMarkUndone(args) {
  return flipItems(args, false);
}

// ── request dispatcher ───────────────────────────────────────────────────────

function dispatch(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      break;

    case "notifications/initialized":
      break;

    case "tools/list":
      reply(id, { tools: [MARK_DONE_TOOL, MARK_UNDONE_TOOL, STATUS_TOOL] });
      break;

    case "tools/call": {
      const toolName = params && params.name;
      const toolArgs = params && params.arguments;

      if (toolName === "mark_done") {
        reply(id, handleMarkDone(toolArgs));
      } else if (toolName === "mark_undone") {
        reply(id, handleMarkUndone(toolArgs));
      } else if (toolName === "status") {
        reply(id, handleStatus(toolArgs));
      } else {
        replyError(id, -32601, `Unknown tool: '${toolName}'`);
      }
      break;
    }

    default:
      if (id !== undefined && id !== null) {
        replyError(id, -32601, `Method not found: '${method}'`);
      }
      break;
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: undefined,
    terminal: false,
  });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    try {
      dispatch(msg);
    } catch (err) {
      const id = msg && msg.id !== undefined ? msg.id : null;
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: `Internal error: ${err.message}` },
      });
    }
  });

  rl.on("close", () => {
    process.exit(0);
  });
}

process.on("uncaughtException", (err) => {
  process.stderr.write(`[roadmap-mcp] uncaughtException: ${err.message}\n`);
});

main();
