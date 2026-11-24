// Runs before every request (Next.js proxy, formerly middleware). Sign-in is required
// everywhere except /login and /auth/sign-in (lib/auth/access.ts): signed-out page
// requests go to /login, signed-out API requests get 401. It also refreshes the Supabase
// session cookies. Route handlers check the user again themselves; this is not the only
// check.

import { NextResponse, type NextRequest } from "next/server";
import { decideAccess, isPublicPath } from "./lib/auth/access";
import { createRequestClient, getRequestUser } from "./lib/supabase/request-client";

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  const rc = createRequestClient(request);
  const user = await getRequestUser(rc);
  const decision = decideAccess(pathname, search, !!user);

  let response: NextResponse;
  if (decision.kind === "allow") {
    // Pass the (possibly refreshed) cookies on to the page or route.
    response = NextResponse.next({ request: { headers: request.headers } });
  } else if (decision.kind === "redirect") {
    // The proxy needs an absolute URL; clone nextUrl (Next keeps its host) and set the path.
    const target = new URL(decision.location, "http://placeholder.invalid");
    const url = request.nextUrl.clone();
    url.pathname = target.pathname;
    url.search = target.search;
    response = NextResponse.redirect(url, 303);
  } else {
    response = NextResponse.json({ error: "sign in required" }, { status: 401 });
  }
  response.headers.set("Cache-Control", "private, no-store");
  return rc ? rc.applyTo(response) : response;
}

export const config = {
  // Everything except Next's hashed build assets, the ONNX Runtime files the build copies
  // from the pinned package (versioned, public code, no app data), and the favicon.
  matcher: ["/((?!_next/static/|_next/image|onnxruntime/|favicon\\.ico$).*)"],
};
