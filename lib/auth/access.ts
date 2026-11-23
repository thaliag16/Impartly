// Which requests need a signed-in user. Everything does, except the sign-in page and the
// sign-in endpoint themselves, and Next's own build assets. The proxy (proxy.ts) applies
// this to every request; route handlers check the user again themselves.

const PUBLIC_PATHS = new Set(["/login", "/auth/sign-in"]);

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  // Next's hashed build output (scripts, styles, fonts). No app data lives there.
  return pathname.startsWith("/_next/static/") || pathname.startsWith("/_next/image");
}

export type AccessDecision =
  | { kind: "allow" }
  | { kind: "redirect"; location: string }
  | { kind: "unauthorized" };

/** Signed out: pages redirect to /login (keeping where they were going), APIs get 401. */
export function decideAccess(pathname: string, search: string, signedIn: boolean): AccessDecision {
  if (signedIn || isPublicPath(pathname)) return { kind: "allow" };
  if (pathname.startsWith("/api/") || pathname.startsWith("/auth/")) return { kind: "unauthorized" };
  const next = safeNextPath(pathname + search);
  return { kind: "redirect", location: next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}` };
}

/**
 * A same-site path to go to after sign-in. Anything that could leave the site
 * ("//evil.example", "/\\evil.example", "https://...", control characters) becomes "/".
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw || typeof raw !== "string" || raw.length > 512) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return "/";
  try {
    const url = new URL(raw, "https://impartly.invalid");
    if (url.origin !== "https://impartly.invalid") return "/";
    return url.pathname + url.search;
  } catch {
    return "/";
  }
}

/**
 * CSRF check for state-changing POSTs: the browser's Origin header must name this site's
 * host (the same check Next.js uses for server actions: Origin's host against
 * X-Forwarded-Host, else Host, else the request URL's host). Browsers send Origin on
 * every cross-origin POST and on same-origin form POSTs; when it is missing,
 * Sec-Fetch-Site must say same-origin. Anything else is refused. This is on top of the
 * session cookies being SameSite=Lax (not sent on cross-site POSTs).
 */
export function isSameOriginPost(request: { method: string; headers: Headers; url: string }): boolean {
  if (request.method !== "POST") return false;
  const origin = request.headers.get("origin");
  if (!origin) return request.headers.get("sec-fetch-site") === "same-origin";
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false; // includes "null"
  }
  const expected =
    request.headers.get("x-forwarded-host")?.split(",")[0].trim() ||
    request.headers.get("host") ||
    new URL(request.url).host;
  return !!originHost && originHost === expected;
}
