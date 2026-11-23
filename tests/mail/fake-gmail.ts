// A fake Gmail API and Google token endpoint for tests, serving fixtures/gmail/*.json.
// No network: it is passed to the adapter as its fetch.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const GMAIL_FIXTURES = path.join(ROOT, "fixtures", "gmail");

export function gmailFixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(path.join(GMAIL_FIXTURES, name), "utf8")) as T;
}

export function messageFixtureIds(): string[] {
  return readdirSync(path.join(GMAIL_FIXTURES, "messages"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface FakeGoogle {
  fetch: typeof fetch;
  requests: RecordedRequest[];
  /** The access token Gmail currently accepts. */
  validAccessToken: string;
  /** What the token endpoint hands out on the next refresh. */
  nextAccessToken: string;
  /** Make the token endpoint answer invalid_grant. */
  refreshRevoked: boolean;
  /** Gmail answers 401 to every request, whatever the token. */
  alwaysUnauthorized: boolean;
  refreshCount: number;
  /** Message ids returned by the list (default: the two fixture pages). */
  emptyList: boolean;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export function createFakeGoogle(initial: { accessToken: string; refreshedAccessToken?: string }): FakeGoogle {
  const state: FakeGoogle = {
    requests: [],
    validAccessToken: initial.accessToken,
    nextAccessToken: initial.refreshedAccessToken ?? "invented-access-token-refreshed",
    refreshRevoked: false,
    alwaysUnauthorized: false,
    refreshCount: 0,
    emptyList: false,
    fetch: undefined as unknown as typeof fetch,
  };

  state.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === "string" ? init.body : undefined;
    state.requests.push({ method, url: url.toString(), headers, body });

    if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token") {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") !== "refresh_token") return json(400, { error: "unsupported_grant_type" });
      if (state.refreshRevoked) return json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
      state.refreshCount++;
      state.validAccessToken = state.nextAccessToken;
      return json(200, {
        access_token: state.nextAccessToken,
        expires_in: 3599,
        scope: "https://www.googleapis.com/auth/gmail.readonly",
        token_type: "Bearer",
      });
    }

    if (url.origin !== "https://gmail.googleapis.com") return json(404, { error: "not found" });
    if (method !== "GET") return json(405, { error: "method not allowed" });
    if (state.alwaysUnauthorized || headers.authorization !== `Bearer ${state.validAccessToken}`) {
      return json(401, { error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } });
    }

    const prefix = "/gmail/v1/users/me";
    const rest = url.pathname.slice(prefix.length);
    if (rest === "/profile") return json(200, gmailFixture("profile.json"));
    if (rest === "/messages") {
      if (state.emptyList) return json(200, gmailFixture("list-empty.json"));
      const page = url.searchParams.get("pageToken") === "invented-page-token-2" ? "list-page-2.json" : "list-page-1.json";
      return json(200, gmailFixture(page));
    }
    const m = rest.match(/^\/messages\/([A-Za-z0-9]+)$/);
    if (m && url.searchParams.get("format") === "full") {
      try {
        return json(200, gmailFixture(`messages/${m[1]}.json`));
      } catch {
        return json(404, { error: { code: 404, message: "Requested entity was not found." } });
      }
    }
    return json(404, { error: "not found" });
  }) as typeof fetch;

  return state;
}
