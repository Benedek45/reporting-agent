// Purpose: extract text/tables from documents uploaded to a session workspace uploads/ dir; SCAFFOLD STUB.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "doc-ingest", version: "0.0.1" });

const registerTool = (name, config, handler) => {
  if (typeof server.registerTool === "function") {
    server.registerTool(name, config, handler);
    return;
  }

  server.tool(name, config.inputSchema, handler);
};

registerTool(
  "list_uploads",
  {
    title: "List uploaded source documents",
    description:
      "Lists the files currently in the session workspace uploads/ directory so the agent knows what source documents are available. Use this before extracting document content or when the user references uploaded evidence without naming a file. Output will be a tight JSON array of objects shaped as { name, size }. Errors will report missing uploads directory, inaccessible files, or unsupported workspace access.",
    inputSchema: {},
  },
  async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            status: "NOT_IMPLEMENTED",
            server: "doc-ingest",
            tool: "list_uploads",
            planned: "List files in the session workspace uploads/ directory and return JSON array entries shaped as { name, size }.",
            received: {},
          },
          null,
          2
        ),
      },
    ],
  })
);

registerTool(
  "extract_document",
  {
    title: "Extract document text & tables",
    description:
      "Extracts plain text and tabular data from a PDF, DOCX, or XLSX document so the agent can pull evidence, figures, tables, and citations into a compliance report. Use this after list_uploads identifies a relevant source file, especially for financial, environmental, workforce, policy, or audit evidence. Output will be structured JSON containing extracted text, tables, page or sheet references, and extraction metadata. Errors will report missing files, paths outside uploads/, unsupported formats, unreadable pages, or extraction failures. Planned libraries: pdfjs-dist (Apache-2.0), mammoth (BSD), and exceljs (MIT).",
    inputSchema: {
      path: z.string().describe("path to a file inside uploads/, e.g. 'uploads/2025_energy.pdf'"),
      pages: z.string().optional().describe("optional page range like '1-5'"),
    },
  },
  async ({ path, pages }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            status: "NOT_IMPLEMENTED",
            server: "doc-ingest",
            tool: "extract_document",
            planned: "Extract text and tables from PDF/DOCX/XLSX files using pdfjs-dist, mammoth, and exceljs, constrained to files inside uploads/.",
            received: { path, pages },
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
