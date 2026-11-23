// Sign-in and sign-out route logic (Supabase Auth, email and password, server-side
// session in httpOnly cookies). The route files under app/auth/ wire these up.
//
// Both are POST-only and refuse cross-site requests (login CSRF and forced sign-out).
// Errors go back to /login with a fixed code; the email and password are never echoed,
// logged or put in a URL.

import { NextResponse, type NextRequest } from "next/server";
import { isSameOriginPost, safeNextPath } from "../auth/access";
import { redirectTo } from "./redirect";
import { createRequestClient, type RequestClientOptions } from "../supabase/request-client";

function redirect(_request: NextRequest, path: string): NextResponse {
  return redirectTo(path);
}

function loginWith(error: string, next: string): string {
  const params = new URLSearchParams({ error });
  if (next !== "/") params.set("next", next);
  return `/login?${params}`;
}

export async function handleSignIn(request: NextRequest, options: RequestClientOptions = {}): Promise<NextResponse> {
  if (!isSameOriginPost(request)) {
    return NextResponse.json({ error: "cross-site request refused" }, { status: 403 });
  }
  let email = "";
  let password = "";
  let next = "/";
  try {
    const form = await request.formData();
    email = String(form.get("email") ?? "").trim();
    password = String(form.get("password") ?? "");
    next = safeNextPath(String(form.get("next") ?? "/"));
  } catch {
    return redirect(request, loginWith("invalid", "/"));
  }
  if (!email || !password || email.length > 320 || password.length > 1024) {
    return redirect(request, loginWith("invalid", next));
  }
  const rc = createRequestClient(request, options);
  if (!rc) return redirect(request, loginWith("not_configured", next));
  try {
    const { data, error } = await rc.client.auth.signInWithPassword({ email, password });
    if (error || !data.session) return redirect(request, loginWith("invalid", next));
  } catch {
    return redirect(request, loginWith("unavailable", next));
  }
  return rc.applyTo(redirect(request, next));
}

export async function handleSignOut(request: NextRequest, options: RequestClientOptions = {}): Promise<NextResponse> {
  if (!isSameOriginPost(request)) {
    return NextResponse.json({ error: "cross-site request refused" }, { status: 403 });
  }
  const rc = createRequestClient(request, options);
  if (rc) {
    try {
      // Ends this browser's session at Supabase and clears the session cookies.
      await rc.client.auth.signOut({ scope: "local" });
    } catch {
      // The cookies are still cleared below.
    }
    return clearSessionCookies(request, rc.applyTo(redirect(request, "/login")));
  }
  return clearSessionCookies(request, redirect(request, "/login"));
}

/** Expires every Supabase session cookie (including chunked ones), whatever signOut did. */
function clearSessionCookies(request: NextRequest, response: NextResponse): NextResponse {
  for (const { name } of request.cookies.getAll()) {
    if (/^sb-[A-Za-z0-9-]+-auth-token(?:\.\d+)?$/.test(name)) {
      response.cookies.set(name, "", { path: "/", maxAge: 0, httpOnly: true, sameSite: "lax" });
    }
  }
  return response;
}
