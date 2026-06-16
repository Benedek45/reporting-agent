export const runtime = "nodejs";

import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { sessionDirectory } from "@/lib/workspace";

interface ReportResponse {
  exists: boolean;
  markdown: string;
}

/**
 * GET /api/report?sessionId=<id>
 * Returns the current report.md content for the session.
 * Returns { exists: false, markdown: "" } if the report has not been written yet.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  if (!sessionId) {
    return Response.json({ error: "sessionId is required" }, { status: 400 });
  }

  try {
    const directory = await sessionDirectory(sessionId);
    const reportPath = path.join(directory, "output", "report.md");

    let markdown: string;
    try {
      markdown = await fs.readFile(reportPath, "utf8");
    } catch {
      const response: ReportResponse = { exists: false, markdown: "" };
      return Response.json(response);
    }

    const response: ReportResponse = { exists: true, markdown };
    return Response.json(response);
  } catch (err) {
    console.error("[GET /api/report]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
