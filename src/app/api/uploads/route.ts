export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { listUploads } from "@/lib/workspace";

export async function GET(req: NextRequest): Promise<Response> {
  try {
    const sessionId = req.nextUrl.searchParams.get("sessionId");

    if (!sessionId) {
      return Response.json(
        { error: "sessionId query parameter is required" },
        { status: 400 }
      );
    }

    const uploads = await listUploads(sessionId);
    return Response.json({ uploads });
  } catch (err) {
    console.error("[GET /api/uploads]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
