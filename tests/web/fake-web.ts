// A fake internet for web-source tests: a DNS table and a set of routes. Nothing here
// opens a socket. Hosts are invented (.example); the resolver answers only what the test
// gives it, so tests can make a public-looking name resolve to a private address.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedAddress, Resolver, Transport, TransportRequest } from "../../lib/sources/web/safe-fetch";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function feedFixture(name: string): string {
  return readFileSync(path.join(ROOT, "fixtures", "feeds", name), "utf8");
}

export interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

export type Route = FakeResponse | ((req: TransportRequest) => FakeResponse | Promise<FakeResponse>);

export interface FakeWeb {
  resolve: Resolver;
  transport: Transport;
  /** Every request the transport received, in order. */
  requests: TransportRequest[];
  /** Every lookup the resolver received. */
  lookups: string[];
  routes: Map<string, Route>;
  dns: Map<string, string[]>;
}

/** A public documentation-free address for invented hosts (TEST-NET is blocked, so use a
 * real-looking public address; nothing ever connects to it). */
export const PUBLIC_V4 = "93.184.215.14";

export function createFakeWeb(options: { routes?: Record<string, Route>; dns?: Record<string, string[]> } = {}): FakeWeb {
  const routes = new Map(Object.entries(options.routes ?? {}));
  const dns = new Map(Object.entries(options.dns ?? {}));
  const requests: TransportRequest[] = [];
  const lookups: string[] = [];

  const resolve: Resolver = async (hostname) => {
    lookups.push(hostname);
    const answer = dns.get(hostname) ?? (hostname.endsWith(".example") ? [PUBLIC_V4] : null);
    if (!answer) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return answer.map((address): ResolvedAddress => ({ address, family: address.includes(":") ? 6 : 4 }));
  };

  const transport: Transport = async (req) => {
    requests.push(req);
    const key = req.url.toString();
    const route = routes.get(key) ?? (req.url.pathname === "/robots.txt" ? { status: 404 } : { status: 404 });
    const res = typeof route === "function" ? await route(req) : route;
    const body = typeof res.body === "string" ? new TextEncoder().encode(res.body) : (res.body ?? new Uint8Array());
    return {
      status: res.status ?? 200,
      headers: Object.fromEntries(Object.entries(res.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
      body: (async function* () {
        // Deliver in small chunks, as a socket would.
        for (let i = 0; i < body.length; i += 16 * 1024) yield body.subarray(i, i + 16 * 1024);
      })(),
    };
  };

  return { resolve, transport, requests, lookups, routes, dns };
}

export const rss = (body: string, headers: Record<string, string> = {}): FakeResponse => ({
  status: 200,
  headers: { "content-type": "application/rss+xml; charset=utf-8", ...headers },
  body,
});
