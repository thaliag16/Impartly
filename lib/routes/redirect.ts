import { NextResponse } from "next/server";

/**
 * A 303 redirect to a path on this site, sent as a relative Location (RFC 9110 allows it).
 * Relative, so it always stays on the host the browser used: behind a proxy, or with
 * Next.js normalizing the host (127.0.0.1 vs localhost), an absolute URL built from the
 * request could point at a different host and lose the session cookies.
 */
export function redirectTo(path: string): NextResponse {
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) {
    throw new Error("redirectTo only takes a same-site path");
  }
  return new NextResponse(null, { status: 303, headers: { Location: path, "Cache-Control": "no-store" } });
}
