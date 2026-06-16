// Purpose: verify a claim/figure against authoritative web sources via a pluggable backend; SCAFFOLD STUB.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fact-check", version: "0.0.1" });
const factcheckBackend = process.env.FACTCHECK_BACKEND || null;
const hasFactcheckApiKey = Boolean(process.env.FACTCHECK_API_KEY);

const registerTool = (name, config, handler) => {
  if (typeof server.registerTool === "function") {
    server.registerTool(name, config, handler);
    return;
  }

  server.tool(name, config.inputSchema, handler);
};

registerTool(
  "verify_claim",
  {
    title: "Verify factual claim with evidence",
    description:
      "Checks an external factual claim or figure, such as a regulatory reference, emission factor, benchmark, threshold, or market statistic, against authoritative web sources. Use this when a report statement depends on current external facts rather than uploaded source documents or the model's memory. Output will be structured JSON with a verdict of CONFIRMED, UNCERTAIN, or CONTRADICTED, concise evidence, source URLs, and caveats. Errors will report missing claim text, unavailable backend credentials, search failures, inaccessible sources, or insufficient evidence. Backend is pluggable and selected by FACTCHECK_BACKEND, such as Exa, Tavily, or Brave Search.",
    inputSchema: {
      claim: z.string().describe("the factual claim or figure to verify"),
      context: z.string().optional().describe("surrounding context, e.g. the report sentence"),
      sources: z.array(z.string()).optional().describe("optional candidate source URLs to check first"),
    },
  },
  async ({ claim, context, sources }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            status: "NOT_IMPLEMENTED",
            server: "fact-check",
            tool: "verify_claim",
            planned: "Verify claims against authoritative sources through a pluggable search/fetch backend selected by FACTCHECK_BACKEND and return CONFIRMED, UNCERTAIN, or CONTRADICTED with evidence.",
            received: {
              claim,
              context,
              sources,
              backend: factcheckBackend,
              api_key_configured: hasFactcheckApiKey,
            },
          },
          null,
          2
        ),
      },
    ],
  })
);

async function main() {
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
