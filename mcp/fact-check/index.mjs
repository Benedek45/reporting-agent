/**
 * fact-check MCP server — zero external dependencies.
 *
 * Launched by the opencode engine container with:
 *   bun run /config/mcp/fact-check/index.mjs
 *
 * The engine container runs oven/bun:1.3.14 (Linux). Node is NOT guaranteed
 * present, so this file uses only bun/node built-ins + global fetch.
 * No @modelcontextprotocol/sdk, no zod, no npm packages.
 *
 * Protocol: MCP JSON-RPC 2.0 over stdio (line-delimited JSON).
 * Handles: initialize, notifications/initialized, tools/list, tools/call.
 *
 * Tool: verify_claim
 *   Input: { claim: string, context?: string }
 *   Behaviour:
 *     - If FACTCHECK_API_KEY is set: calls Tavily Search API and returns a
 *       structured verdict (SUPPORTED | CONTRADICTED | UNCERTAIN) with evidence.
 *     - If FACTCHECK_API_KEY is unset: returns a NEEDS_CONFIG status so the
 *       agent knows to fall back to manual verification.
 */

import readline from "node:readline";

// ── constants ────────────────────────────────────────────────────────────────

const SERVER_INFO = { name: "fact-check", version: "0.1.0" };
const PROTOCOL_VERSION = "2024-11-05";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

// ── tool definition ──────────────────────────────────────────────────────────

const VERIFY_CLAIM_TOOL = {
  name: "verify_claim",
  description:
    "Checks an external factual claim or figure against authoritative web sources via Tavily Search. " +
    "Use this for regulatory references, emission factors, benchmarks, thresholds, or market statistics — " +
    "anything that depends on current external facts rather than the user's uploaded documents. " +
    "Returns a verdict of SUPPORTED, CONTRADICTED, or UNCERTAIN with a short evidence list. " +
    "If the API key is not configured, returns NEEDS_CONFIG so you can fall back to manual verification.",
  inputSchema: {
    type: "object",
    properties: {
      claim: {
        type: "string",
        description: "The factual claim or figure to verify, stated as a complete sentence.",
      },
      context: {
        type: "string",
        description:
          "Optional surrounding context, e.g. the report sentence this claim appears in. " +
          "Helps the search produce more relevant results.",
      },
    },
    required: ["claim"],
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

// ── verdict heuristic ────────────────────────────────────────────────────────

/**
 * Derive a simple verdict from the Tavily response.
 *
 * Heuristic (clearly hedged — not a legal determination):
 *   - If Tavily returns an `answer` field that is non-empty → SUPPORTED
 *     (Tavily's answer synthesis means it found corroborating sources).
 *   - If results are returned but no answer → UNCERTAIN
 *     (sources exist but Tavily couldn't synthesise a direct answer).
 *   - If no results at all → UNCERTAIN
 *     (insufficient evidence either way).
 *
 * We never return CONTRADICTED automatically because detecting contradiction
 * reliably requires semantic reasoning beyond a keyword search. The agent
 * should inspect the evidence and escalate if something looks wrong.
 */
function deriveVerdict(tavilyResponse) {
  const answer = tavilyResponse.answer;
  const results = Array.isArray(tavilyResponse.results) ? tavilyResponse.results : [];

  if (answer && answer.trim().length > 0) {
    return "SUPPORTED";
  }
  return "UNCERTAIN";
}

// ── tool handler ─────────────────────────────────────────────────────────────

async function handleVerifyClaim(args) {
  const claim = args && typeof args.claim === "string" ? args.claim.trim() : "";
  const context = args && typeof args.context === "string" ? args.context.trim() : "";

  if (!claim) {
    return toolResult(
      textContent(
        JSON.stringify({
          status: "ERROR",
          error: "The 'claim' argument is required and must be a non-empty string.",
        })
      ),
      true
    );
  }

  const apiKey = process.env.FACTCHECK_API_KEY || "";

  // ── unconfigured path ────────────────────────────────────────────────────
  if (!apiKey) {
    return toolResult(
      textContent(
        JSON.stringify({
          status: "NEEDS_CONFIG",
          note:
            "Set FACTCHECK_API_KEY (Tavily) to enable automated fact-checking; " +
            "until then verify manually.",
        })
      ),
      false
    );
  }

  // ── Tavily search ────────────────────────────────────────────────────────
  // Build the query: combine claim + context for better relevance.
  const query = context ? `${claim} — context: ${context}` : claim;

  let tavilyResponse;
  try {
    const response = await fetch(TAVILY_SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: 5,
        include_answer: true,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "(no body)");
      return toolResult(
        textContent(
          JSON.stringify({
            verdict: "UNCERTAIN",
            note: `Tavily API returned HTTP ${response.status}. Verify manually.`,
            error_detail: body.slice(0, 500),
          })
        ),
        false
      );
    }

    tavilyResponse = await response.json();
  } catch (err) {
    // Network or parse error — return gracefully, never throw.
    return toolResult(
      textContent(
        JSON.stringify({
          verdict: "UNCERTAIN",
          note: `Could not reach Tavily Search API: ${err.message}. Verify manually.`,
        })
      ),
      false
    );
  }

  // ── format result ────────────────────────────────────────────────────────
  const verdict = deriveVerdict(tavilyResponse);
  const answer = tavilyResponse.answer || null;
  const results = Array.isArray(tavilyResponse.results) ? tavilyResponse.results : [];

  const evidenceLines = results
    .slice(0, 5)
    .map((r) => `- ${r.title || "(no title)"} — ${r.url || "(no url)"}`)
    .join("\n");

  const lines = [
    `VERDICT: ${verdict}`,
    "",
    verdict === "SUPPORTED"
      ? "Note: SUPPORTED means Tavily synthesised a corroborating answer from web sources. " +
        "This is a heuristic — review the evidence below before treating it as definitive."
      : "Note: UNCERTAIN means no direct corroborating answer was found. " +
        "Review the sources below and verify manually if the claim is material.",
    "",
  ];

  if (answer) {
    lines.push("Tavily answer:", answer, "");
  }

  if (evidenceLines) {
    lines.push("Evidence sources:", evidenceLines, "");
  } else {
    lines.push("No sources returned by Tavily.", "");
  }

  lines.push(`Claim checked: "${claim}"`);

  return toolResult(textContent(lines.join("\n")), false);
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
      reply(id, { tools: [VERIFY_CLAIM_TOOL] });
      break;

    case "tools/call": {
      const toolName = params && params.name;
      const toolArgs = params && params.arguments;

      if (toolName === "verify_claim") {
        // handleVerifyClaim is async; we must await it and then reply.
        handleVerifyClaim(toolArgs).then(
          (result) => reply(id, result),
          (err) => {
            // Should never reach here (handler catches internally), but guard anyway.
            reply(id, toolResult(
              textContent(
                JSON.stringify({
                  verdict: "UNCERTAIN",
                  note: `Internal handler error: ${err.message}. Verify manually.`,
                })
              ),
              false
            ));
          }
        );
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
  process.stderr.write(`[fact-check-mcp] uncaughtException: ${err.message}\n`);
});

main();
