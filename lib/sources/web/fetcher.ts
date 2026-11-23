// The polite web fetcher: safeFetch (SSRF-safe, bounded) plus robots.txt and an honest
// user agent. Every web request Impartly makes goes through `get`.
//
//   * User-Agent names Impartly and links the public repository, so a site owner can see
//     who is fetching and how to block it (robots.txt token: "Impartly").
//   * robots.txt is read once per origin per fetcher (one fetcher per pipeline run) and
//     checked for every URL, redirects included.
//   * Bounded: 10 s per request, 5 redirects, 2 MiB for feeds, 1 MiB for pages.
// It never sends cookies or credentials, and never retries around a refusal (401, 402,
// 403 and 451 are returned as they are, never worked around).

import { SourceFetchError } from "../types";
import { policyAllows, policyFromResponse, ROBOTS_MAX_BYTES, type RobotsPolicy } from "./robots";
import { decodeBody, safeFetch, type SafeFetchDeps, type SafeResponse } from "./safe-fetch";

export const REPO_URL = "https://github.com/thaliag16/impartly";
export const ROBOTS_TOKEN = "impartly";
export const USER_AGENT = `Impartly/0.1 (+${REPO_URL}; newsletter reader; robots token: Impartly)`;

export const LIMITS = Object.freeze({
  timeoutMs: 10_000,
  maxRedirects: 5,
  feedBytes: 2 * 1024 * 1024,
  pageBytes: 1024 * 1024,
});

export interface FetchedText {
  url: URL;
  status: number;
  headers: Record<string, string>;
  text: string;
}

export interface GetOptions {
  /** Accept header. */
  accept: string;
  maxBytes: number;
  /** Conditional GET validators. */
  etag?: string | null;
  lastModified?: string | null;
}

export interface WebFetcher {
  get(url: string | URL, options: GetOptions): Promise<FetchedText>;
}

export function createWebFetcher(deps: SafeFetchDeps = {}): WebFetcher {
  // An unreadable robots.txt (5xx, network error, timeout, too large) means "disallow
  // all" (RFC 9309); `reason` keeps the underlying code so the error says why.
  type Checked = { policy: RobotsPolicy; reason?: string };
  const robots = new Map<string, Promise<Checked>>();

  const robotsFor = (url: URL): Promise<Checked> => {
    const origin = url.origin;
    let p = robots.get(origin);
    if (!p) {
      p = (async () => {
        try {
          const res = await safeFetch(
            new URL("/robots.txt", origin),
            {
              headers: { "user-agent": USER_AGENT, accept: "text/plain, */*;q=0.1" },
              maxBytes: ROBOTS_MAX_BYTES,
              timeoutMs: LIMITS.timeoutMs,
              maxRedirects: LIMITS.maxRedirects,
            },
            deps,
          );
          const policy = policyFromResponse(res.status, decodeBody(res.body, res.headers["content-type"]), ROBOTS_TOKEN);
          return policy.kind === "disallow-all" ? { policy, reason: "robots_unreachable" } : { policy };
        } catch (err) {
          // Over 500 KiB: RFC 9309 lets a crawler parse only the first part, but safeFetch
          // keeps no partial read, so it counts as unreachable (disallow) too.
          const code = err instanceof SourceFetchError ? err.code : "network_error";
          return { policy: { kind: "disallow-all" }, reason: code };
        }
      })();
      robots.set(origin, p);
    }
    return p;
  };

  return {
    async get(url, options) {
      const headers: Record<string, string> = { "user-agent": USER_AGENT, accept: options.accept };
      if (options.etag) headers["if-none-match"] = options.etag;
      if (options.lastModified) headers["if-modified-since"] = options.lastModified;
      const res: SafeResponse = await safeFetch(
        url,
        {
          headers,
          maxBytes: options.maxBytes,
          timeoutMs: LIMITS.timeoutMs,
          maxRedirects: LIMITS.maxRedirects,
          beforeRequest: async (u) => {
            const checked = await robotsFor(u);
            if (!policyAllows(checked.policy, u)) throw new SourceFetchError(checked.reason ?? "robots_disallowed");
          },
        },
        deps,
      );
      return {
        url: res.url,
        status: res.status,
        headers: res.headers,
        text: res.status === 304 ? "" : decodeBody(res.body, res.headers["content-type"]),
      };
    },
  };
}
