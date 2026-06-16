// Purpose: render the agent's Markdown report into a deliverable; SCAFFOLD STUB.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "doc-generate", version: "0.0.1" });

const registerTool = (name, config, handler) => {
  if (typeof server.registerTool === "function") {
    server.registerTool(name, config, handler);
    return;
  }

  server.tool(name, config.inputSchema, handler);
};

registerTool(
  "render_report",
  {
    title: "Render Markdown report deliverable",
    description:
      "Converts the finished report.md into a PDF or DOCX deliverable for review, filing, or distribution. Use this only after the agent has completed and checked the Markdown report content. Output will be structured JSON with the requested format, output path, rendering metadata, and any warnings. Errors will report missing input, invalid format, write failures, rendering failures, or unsupported styling/assets. Planned approach: Markdown to HTML to PDF using tools such as md-to-pdf/puppeteer, and DOCX generation via the docx library (MIT).",
    inputSchema: {
      input_path: z.string().default("output/report.md").describe("the report markdown to render"),
      format: z.enum(["pdf", "docx"]).describe("deliverable format"),
      output_path: z.string().optional().describe("where to write the result; defaults next to input"),
    },
  },
  async ({ input_path, format, output_path }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            status: "NOT_IMPLEMENTED",
            server: "doc-generate",
            tool: "render_report",
            planned: "Render Markdown reports to PDF through Markdown-to-HTML-to-PDF tooling and to DOCX through the docx library.",
            received: { input_path, format, output_path },
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
