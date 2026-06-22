import { NextRequest, NextResponse } from "next/server";

/**
 * BFF authentication (audit C-1).
 *
 * Every /api/* route and page is unauthenticated by default, which is acceptable
 * for single-operator local dev but is a cross-session data-leak risk if the app
 * is reachable by anything else (including the opencode engine container's own
 * webfetch tool — see the SSRF guard in vendor/opencode webfetch.ts for the
 * primary mitigation of that specific vector).
 *
 * This middleware adds optional HTTP Basic Auth. It is a NO-OP unless BOTH
 * APP_BASIC_AUTH_USER and APP_BASIC_AUTH_PASS are set in the app container's
 * environment. Those vars are intentionally NOT given to the opencode/converter
 * containers, so a request originating from inside the engine cannot authenticate.
 *
 * The browser prompts the operator once and caches the credentials for the origin,
 * transparently attaching them to every subsequent page + fetch (incl. SSE), so
 * normal use is unaffected once enabled.
 *
 * Credentials are never embedded in any response body, so the engine's webfetch
 * cannot scrape them from the served HTML/JS.
 */

export const config = {
  // Protect everything except Next's static assets and the favicon/icon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};

export function middleware(req: NextRequest): NextResponse {
  const user = process.env.APP_BASIC_AUTH_USER;
  const pass = process.env.APP_BASIC_AUTH_PASS;

  // Auth disabled (dev default) — behave exactly as before.
  if (!user || !pass) return NextResponse.next();

  const header = req.headers.get("authorization");
  if (header) {
    const [scheme, encoded] = header.split(" ");
    if (scheme === "Basic" && encoded) {
      // Edge runtime: use atob (Buffer is not guaranteed). Creds are ASCII.
      let decoded = "";
      try {
        decoded = atob(encoded);
      } catch {
        decoded = "";
      }
      const sep = decoded.indexOf(":");
      if (sep !== -1) {
        const u = decoded.slice(0, sep);
        const p = decoded.slice(sep + 1);
        if (safeEqual(u, user) && safeEqual(p, pass)) {
          return NextResponse.next();
        }
      }
    }
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="reporting-agent", charset="UTF-8"',
    },
  });
}

// Length-stable comparison to avoid trivial timing leaks. Not constant-time across
// lengths, but adequate for a single-operator shared secret.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
