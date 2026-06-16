/**
 * time MCP server — zero external dependencies.
 *
 * Launched by the opencode engine container with:
 *   bun run /config/mcp/time/index.mjs
 *
 * The engine container runs oven/bun:1.3.14 (Linux). Node is NOT guaranteed
 * present, so this file uses only bun/node built-ins: node:readline.
 * No @modelcontextprotocol/sdk, no zod, no npm packages.
 *
 * Protocol: MCP JSON-RPC 2.0 over stdio (line-delimited JSON).
 * Handles: initialize, notifications/initialized, tools/list, tools/call.
 *
 * Tool: get_current_time
 *   Input: { timezone?: string }  (IANA timezone name, e.g. "Europe/Berlin"; defaults to "UTC")
 *   Output: ISO-8601 timestamp + human-readable line.
 */

import readline from "node:readline";

// ── constants ────────────────────────────────────────────────────────────────

const SERVER_INFO = { name: "time", version: "0.0.1" };
const PROTOCOL_VERSION = "2024-11-05";

// ── tool definition ──────────────────────────────────────────────────────────

const GET_CURRENT_TIME_TOOL = {
  name: "get_current_time",
  description:
    "Returns the current date and time. " +
    "Optionally accepts an IANA timezone name (e.g. 'Europe/Berlin', 'America/New_York'). " +
    "Defaults to UTC. " +
    "Use this whenever you need to know today's date or the current time — do not guess.",
  inputSchema: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description:
          "IANA timezone name, e.g. 'UTC', 'Europe/Berlin', 'America/New_York'. Defaults to 'UTC'.",
      },
    },
    required: [],
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

// ── tool handler ─────────────────────────────────────────────────────────────

function handleGetCurrentTime(args) {
  const rawTz = (args && typeof args.timezone === "string" && args.timezone.trim()) || "UTC";

  // Validate the timezone by attempting to use it; fall back to UTC on error.
  let timezone = rawTz;
  try {
    // Intl.DateTimeFormat throws a RangeError for unknown timezone identifiers.
    Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    return toolResult(
      textContent(
        `Error: '${rawTz}' is not a recognised IANA timezone name. ` +
          "Use a name like 'UTC', 'Europe/Berlin', or 'America/New_York'."
      ),
      true
    );
  }

  const now = new Date();

  // ISO-8601 in the requested timezone (via manual offset calculation).
  // We use Intl to get the offset and format the human line; for the ISO string
  // we compute the offset-adjusted time.
  const iso = now.toISOString(); // always UTC ISO

  // Human-readable line using Intl.DateTimeFormat.
  const humanFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
  const humanLine = humanFormatter.format(now);

  // Offset-aware ISO string for the requested timezone.
  // We derive the UTC offset by comparing the timezone's local time parts to UTC.
  let isoWithOffset = iso; // fallback: UTC ISO
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(now);

    const get = (type) => parts.find((p) => p.type === type)?.value ?? "00";
    const localYear = get("year");
    const localMonth = get("month");
    const localDay = get("day");
    let localHour = get("hour");
    const localMinute = get("minute");
    const localSecond = get("second");

    // "en-CA" hour12:false can return "24" for midnight — normalise.
    if (localHour === "24") localHour = "00";

    // Compute UTC offset in minutes.
    const localMs = Date.UTC(
      Number(localYear),
      Number(localMonth) - 1,
      Number(localDay),
      Number(localHour),
      Number(localMinute),
      Number(localSecond)
    );
    const offsetMin = Math.round((localMs - now.getTime()) / 60000);
    const sign = offsetMin >= 0 ? "+" : "-";
    const absMin = Math.abs(offsetMin);
    const offH = String(Math.floor(absMin / 60)).padStart(2, "0");
    const offM = String(absMin % 60).padStart(2, "0");

    isoWithOffset =
      `${localYear}-${localMonth}-${localDay}T` +
      `${localHour}:${localMinute}:${localSecond}` +
      `${sign}${offH}:${offM}`;
  } catch {
    // Non-fatal: fall back to UTC ISO.
  }

  const text =
    `Current time (${timezone}):\n` +
    `  ISO-8601 : ${isoWithOffset}\n` +
    `  Human    : ${humanLine}`;

  return toolResult(textContent(text), false);
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
      // Notification — no response required.
      break;

    case "tools/list":
      reply(id, { tools: [GET_CURRENT_TIME_TOOL] });
      break;

    case "tools/call": {
      const toolName = params && params.name;
      const toolArgs = params && params.arguments;

      if (toolName === "get_current_time") {
        reply(id, handleGetCurrentTime(toolArgs));
      } else {
        replyError(id, -32601, `Unknown tool: '${toolName}'`);
      }
      break;
    }

    default:
      if (id !== undefined && id !== null) {
        // Only reply to requests (which have an id), not notifications.
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
      // Malformed JSON — send a parse error. Use null id per JSON-RPC spec.
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

// Guard against uncaught errors crashing the process silently.
process.on("uncaughtException", (err) => {
  process.stderr.write(`[time-mcp] uncaughtException: ${err.message}\n`);
});

main();
