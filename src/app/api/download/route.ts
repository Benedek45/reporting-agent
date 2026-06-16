export const runtime = "nodejs";

import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveWorkspaceFile } from "@/lib/workspace";

const CONVERTER_URL =
  process.env.CONVERTER_URL ?? "http://converter:8000";

type DownloadFormat = "original" | "md" | "pdf" | "docx";

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  md: "text/markdown; charset=utf-8",
  original: "application/octet-stream",
};

/**
 * Determines whether a file is a plain-text file by extension.
 */
function isTextExtension(ext: string): boolean {
  const textExts = new Set([
    ".md", ".txt", ".csv", ".json", ".xml", ".html", ".htm",
    ".yaml", ".yml", ".toml", ".ini", ".log", ".rst",
  ]);
  return textExts.has(ext.toLowerCase());
}

/**
 * Resolves the absolute path to a named file within the session workspace.
 * Handles the three known file kinds:
 *   - "report.md"  → output/report.md
 *   - "goal.md"    → goal.md (workspace root)
 *   - anything else → uploads/<name>
 *
 * Returns null if the name is unsafe (path traversal attempt).
 */
async function resolveFilePath(
  sessionId: string,
  name: string
): Promise<string | null> {
  // Reject any path traversal
  const safeName = path.basename(name);
  if (safeName !== name || safeName === "" || safeName === "." || safeName === "..") {
    return null;
  }

  if (name === "report.md") {
    return resolveWorkspaceFile(sessionId, "report.md", "output");
  }

  if (name === "goal.md") {
    return resolveWorkspaceFile(sessionId, "goal.md");
  }

  // Default: uploads directory
  return resolveWorkspaceFile(sessionId, name, "uploads");
}

/**
 * GET /api/download?sessionId=&name=&format=
 *
 * format:
 *   "original" → raw bytes of the source file
 *   "md"       → markdown representation (sidecar .md for uploads; file itself for report/goal)
 *   "pdf"      → POST /render to converter, stream back PDF
 *   "docx"     → POST /render to converter, stream back DOCX
 */
export async function GET(req: NextRequest): Promise<Response> {
  const { searchParams } = req.nextUrl;
  const sessionId = searchParams.get("sessionId");
  const name = searchParams.get("name");
  const format = (searchParams.get("format") ?? "original") as DownloadFormat;

  if (!sessionId) {
    return Response.json({ error: "sessionId is required" }, { status: 400 });
  }
  if (!name) {
    return Response.json({ error: "name is required" }, { status: 400 });
  }
  if (!["original", "md", "pdf", "docx"].includes(format)) {
    return Response.json({ error: "Invalid format" }, { status: 400 });
  }

  // Reject path traversal in name
  const safeName = path.basename(name);
  if (safeName !== name || safeName === "" || safeName === "." || safeName === "..") {
    return Response.json({ error: "Invalid file name" }, { status: 400 });
  }

  try {
    const filePath = await resolveFilePath(sessionId, name);
    if (!filePath) {
      return Response.json({ error: "Invalid file name" }, { status: 400 });
    }

    const isReportOrGoal = name === "report.md" || name === "goal.md";

    if (format === "original") {
      // Serve raw bytes
      let data: Buffer;
      try {
        data = await fs.readFile(filePath);
      } catch {
        return Response.json({ error: "File not found" }, { status: 404 });
      }

      const ext = path.extname(name).toLowerCase();
      const contentType = isTextExtension(ext)
        ? `text/plain; charset=utf-8`
        : "application/octet-stream";

      return new Response(new Uint8Array(data), {
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${encodeURIComponent(name)}"`,
          "Content-Length": String(data.byteLength),
        },
      });
    }

    if (format === "md") {
      let markdown: string;

      if (isReportOrGoal) {
        // The file itself is already markdown
        try {
          markdown = await fs.readFile(filePath, "utf8");
        } catch {
          return Response.json({ error: "File not found" }, { status: 404 });
        }
      } else {
        // For uploads: prefer the .md sidecar
        const sidecarPath = `${filePath}.md`;
        try {
          markdown = await fs.readFile(sidecarPath, "utf8");
        } catch {
          // Fall back to source if it's a text file
          try {
            markdown = await fs.readFile(filePath, "utf8");
          } catch {
            return Response.json({ error: "File not found" }, { status: 404 });
          }
        }
      }

      const mdName = name.endsWith(".md") ? name : `${name}.md`;
      return new Response(markdown, {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="${encodeURIComponent(mdName)}"`,
        },
      });
    }

    // format === "pdf" | "docx"
    // Read the markdown representation first
    let markdown: string;

    if (isReportOrGoal) {
      try {
        markdown = await fs.readFile(filePath, "utf8");
      } catch {
        return Response.json({ error: "File not found" }, { status: 404 });
      }
    } else {
      const sidecarPath = `${filePath}.md`;
      try {
        markdown = await fs.readFile(sidecarPath, "utf8");
      } catch {
        try {
          markdown = await fs.readFile(filePath, "utf8");
        } catch {
          return Response.json({ error: "File not found" }, { status: 404 });
        }
      }
    }

    // POST to converter /render
    const renderRes = await fetch(`${CONVERTER_URL}/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown, format }),
    });

    if (!renderRes.ok) {
      const errBody = await renderRes.text().catch(() => "(unreadable)");
      console.error(`[GET /api/download] converter /render error ${renderRes.status}: ${errBody}`);
      return Response.json(
        { error: `Converter error: ${renderRes.status}` },
        { status: 502 }
      );
    }

    const baseName = name.replace(/\.[^.]+$/, "");
    const outputName = `${baseName}.${format}`;
    const contentType = CONTENT_TYPES[format] ?? "application/octet-stream";

    // Stream the converter response body directly to the client
    return new Response(renderRes.body, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${encodeURIComponent(outputName)}"`,
      },
    });
  } catch (err) {
    console.error("[GET /api/download]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
