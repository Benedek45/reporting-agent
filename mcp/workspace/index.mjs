/**
 * workspace MCP server — zero external dependencies.
 *
 * Launched by the opencode engine container with:
 *   bun run /config/mcp/workspace/index.mjs
 *
 * The engine container runs oven/bun:1.3.14 (Linux). Node is NOT guaranteed
 * present, so this file uses only bun/node built-ins: node:fs, node:path,
 * node:readline. No @modelcontextprotocol/sdk, no zod, no npm packages.
 *
 * Protocol: MCP JSON-RPC 2.0 over stdio (line-delimited JSON).
 * Handles: initialize, notifications/initialized, tools/list, tools/call.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

// ── constants ────────────────────────────────────────────────────────────────

const SERVER_INFO = { name: "workspace", version: "0.0.1" };
const PROTOCOL_VERSION = "2024-11-05";

/** Safety boundary: the MCP server may only delete files under this prefix. */
const WORKSPACE_ROOT = "/workspaces/";

// ── tool definition ──────────────────────────────────────────────────────────

const DELETE_FILE_TOOL = {
  name: "delete_file",
  description:
    "Deletes a file from the current report workspace. " +
    "Use when the user asks to remove an uploaded document. " +
    "Pass the file's ABSOLUTE path under /workspaces " +
    "(e.g. /workspaces/<session-id>/uploads/energy.pdf). " +
    "If a Markdown sidecar (<path>.md) exists it is also deleted. " +
    "The agent's working directory is the session workspace, so you can " +
    "list the uploads/ directory to find the exact absolute path before calling this tool.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Absolute path under /workspaces, e.g. /workspaces/<id>/uploads/energy.pdf",
      },
    },
    required: ["path"],
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

function handleDeleteFile(args) {
  const rawPath = args && args.path;
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    return toolResult(
      textContent(JSON.stringify({ error: "path argument is required and must be a non-empty string" })),
      true
    );
  }

  // Resolve to an absolute, normalised path (no symlink resolution here —
  // the container doesn't expose symlinks outside /workspaces, and
  // fs.realpathSync would throw if the file doesn't exist yet).
  const resolved = path.resolve(rawPath);

  // Safety check: must be strictly under /workspaces/
  if (!resolved.startsWith(WORKSPACE_ROOT)) {
    return toolResult(
      textContent(
        JSON.stringify({
          error: `Refused: path '${resolved}' is outside the allowed workspace root '${WORKSPACE_ROOT}'.`,
        })
      ),
      true
    );
  }

  // Delete the primary file
  let deleted = false;
  if (fs.existsSync(resolved)) {
    try {
      fs.unlinkSync(resolved);
      deleted = true;
    } catch (err) {
      return toolResult(
        textContent(JSON.stringify({ error: `Failed to delete '${resolved}': ${err.message}` })),
        true
      );
    }
  }

  // Delete the Markdown sidecar if present (e.g. energy.pdf.md)
  const sidecarPath = resolved + ".md";
  let sidecarDeleted = false;
  if (fs.existsSync(sidecarPath)) {
    try {
      fs.unlinkSync(sidecarPath);
      sidecarDeleted = true;
    } catch {
      // Non-fatal: primary file was already deleted; report sidecar failure in result.
      return toolResult(
        textContent(
          JSON.stringify({
            deleted,
            path: resolved,
            sidecarDeleted: false,
            sidecarError: `Could not delete sidecar '${sidecarPath}'`,
          })
        ),
        false
      );
    }
  }

  if (!deleted) {
    return toolResult(
      textContent(
        JSON.stringify({
          error: `File not found: '${resolved}'`,
          path: resolved,
        })
      ),
      true
    );
  }

  return toolResult(
    textContent(JSON.stringify({ deleted: true, path: resolved, sidecarDeleted })),
    false
  );
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
      reply(id, { tools: [DELETE_FILE_TOOL] });
      break;

    case "tools/call": {
      const toolName = params && params.name;
      const toolArgs = params && params.arguments;

      if (toolName === "delete_file") {
        reply(id, handleDeleteFile(toolArgs));
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
  process.stderr.write(`[workspace-mcp] uncaughtException: ${err.message}\n`);
});

main();
