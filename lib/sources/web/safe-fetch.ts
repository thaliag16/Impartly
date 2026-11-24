// The only way Impartly fetches anything from the public web. Server-side, GET only.
//
// Every request, and every redirect hop, is checked before anything is sent:
//   * http or https only, no user:password in the URL, default ports only (80 and 443)
//   * the host name is not a local name (localhost, *.internal, a bare name, ...)
//   * the host name is resolved, EVERY address it resolves to must be public
//     (address-policy.ts), and the connection is made to that checked address, never to a
//     second lookup (so DNS rebinding cannot swap in a private address)
//   * an optional beforeRequest hook (the robots.txt check, fetcher.ts) may refuse it
// Then: at most `maxRedirects` redirects, one deadline for the whole request chain (redirects
// included), at most `maxBytes` read off the wire AND at most `maxBytes` after
// decompression (a small gzip cannot expand into a huge body).
//
// Errors are SourceFetchError with a short code; no URL or response text is put in them,
// so they are safe to log and to show.

import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from "node:zlib";
import { SourceFetchError } from "../types";
import { isBlockedHostname, isPublicAddress } from "./address-policy";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolves a host name to every address it has. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface TransportRequest {
  url: URL;
  /** The checked address to connect to. The Host header and TLS name stay `url.hostname`. */
  address: ResolvedAddress;
  headers: Record<string, string>;
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  /** Header names lower-cased. */
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
}

/** Sends one GET to exactly the given address. Never follows redirects itself. */
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export interface SafeFetchDeps {
  resolve?: Resolver;
  transport?: Transport;
  /** Overrides the address check. Tests only (to reach a local test server). */
  isAllowedAddress?: (address: string) => boolean;
}

export interface SafeFetchOptions {
  headers?: Record<string, string>;
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  /** Called with each URL (first and every redirect) before it is requested; throw to refuse. */
  beforeRequest?: (url: URL) => Promise<void>;
}

export interface SafeResponse {
  /** The URL that answered (after redirects). */
  url: URL;
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  redirects: number;
}

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

/** Parses and checks a URL the fetcher may request. Throws SourceFetchError. */
export function checkUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SourceFetchError("invalid_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SourceFetchError("unsupported_scheme");
  if (url.username || url.password) throw new SourceFetchError("credentials_in_url");
  // URL drops an explicit default port, so any port left is a non-default one.
  if (url.port && url.port !== DEFAULT_PORTS[url.protocol]) throw new SourceFetchError("unsupported_port");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new SourceFetchError("blocked_address");
  } else if (isBlockedHostname(host)) {
    throw new SourceFetchError("blocked_host");
  }
  url.hash = "";
  return url;
}

export const systemResolver: Resolver = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

/** Node http/https, connecting to the checked address only (custom lookup). */
export const nodeTransport: Transport = ({ url, address, headers, signal }) =>
  new Promise((resolve, reject) => {
    // Whatever name Node asks to look up, the answer is the address already checked.
    const pinned = ((_host: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) => {
      if (options?.all) cb(null, [{ address: address.address, family: address.family }]);
      else cb(null, address.address, address.family);
    }) as unknown as LookupFunction;
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || DEFAULT_PORTS[url.protocol],
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers,
        lookup: pinned,
        agent: false,
        signal,
      },
      (res) => {
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v !== undefined) h[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
        }
        resolve({ status: res.statusCode ?? 0, headers: h, body: res });
      },
    );
    req.on("error", reject);
    req.end();
  });

function decompress(body: Uint8Array, encoding: string, maxBytes: number): Uint8Array {
  const enc = encoding.trim().toLowerCase();
  const opts = { maxOutputLength: maxBytes };
  try {
    if (!enc || enc === "identity") return body;
    if (enc === "gzip" || enc === "x-gzip") return gunzipSync(body, opts);
    if (enc === "br") return brotliDecompressSync(body, opts);
    if (enc === "deflate") {
      try {
        return inflateSync(body, opts);
      } catch (err) {
        if (err instanceof RangeError) throw err;
        return inflateRawSync(body, opts); // some servers send raw deflate
      }
    }
  } catch (err) {
    if (err instanceof RangeError || (err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
      throw new SourceFetchError("too_large");
    }
    throw new SourceFetchError("bad_encoding");
  }
  throw new SourceFetchError("bad_encoding");
}

async function readLimited(body: AsyncIterable<Uint8Array>, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    if (signal.aborted) throw new SourceFetchError("timeout");
    total += chunk.byteLength;
    if (total > maxBytes) throw new SourceFetchError("too_large");
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function isAbort(err: unknown): boolean {
  const e = err as { name?: string; code?: string };
  return e?.name === "AbortError" || e?.name === "TimeoutError" || e?.code === "ABORT_ERR";
}

export async function safeFetch(input: string | URL, options: SafeFetchOptions, deps: SafeFetchDeps = {}): Promise<SafeResponse> {
  const resolve = deps.resolve ?? systemResolver;
  const transport = deps.transport ?? nodeTransport;
  const allowed = deps.isAllowedAddress ?? isPublicAddress;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const signal = controller.signal;

  try {
    let url = checkUrl(input);
    for (let redirects = 0; ; redirects++) {
      await options.beforeRequest?.(url);

      const host = url.hostname.replace(/^\[|\]$/g, "");
      let addresses: ResolvedAddress[];
      if (isIP(host)) {
        addresses = [{ address: host, family: isIP(host) === 6 ? 6 : 4 }];
      } else {
        try {
          addresses = await resolve(host);
        } catch {
          throw new SourceFetchError("dns_failed");
        }
      }
      if (!addresses.length) throw new SourceFetchError("dns_failed");
      // Every address must be allowed, not just the one we would pick: a host that
      // resolves to both a public and a private address is refused.
      if (!addresses.every((a) => allowed(a.address))) throw new SourceFetchError("blocked_address");
      if (signal.aborted) throw new SourceFetchError("timeout");

      let res: TransportResponse;
      try {
        res = await transport({
          url,
          address: addresses[0],
          headers: { "accept-encoding": "gzip, deflate, br", ...options.headers },
          signal,
        });
      } catch (err) {
        if (err instanceof SourceFetchError) throw err;
        throw new SourceFetchError(signal.aborted || isAbort(err) ? "timeout" : "network_error");
      }

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        // Do not read the redirect body.
        const location = res.headers["location"];
        if (!location) throw new SourceFetchError("bad_redirect");
        if (redirects >= options.maxRedirects) throw new SourceFetchError("too_many_redirects");
        const next = checkUrl(new URL(location, url));
        // Never step down from https to http.
        if (url.protocol === "https:" && next.protocol === "http:") throw new SourceFetchError("insecure_redirect");
        url = next;
        continue;
      }

      let raw: Uint8Array;
      try {
        raw = await readLimited(res.body, options.maxBytes, signal);
      } catch (err) {
        if (err instanceof SourceFetchError) throw err;
        throw new SourceFetchError(signal.aborted || isAbort(err) ? "timeout" : "network_error");
      }
      const body = decompress(raw, res.headers["content-encoding"] ?? "", options.maxBytes);
      return { url, status: res.status, headers: res.headers, body, redirects };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Decodes a body to text: BOM, then the Content-Type charset, then the document's own
 * declaration (XML encoding or HTML meta charset), else UTF-8. */
export function decodeBody(body: Uint8Array, contentType = ""): string {
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return new TextDecoder("utf-8").decode(body.subarray(3));
  if (body[0] === 0xff && body[1] === 0xfe) return new TextDecoder("utf-16le").decode(body.subarray(2));
  if (body[0] === 0xfe && body[1] === 0xff) return new TextDecoder("utf-16be").decode(body.subarray(2));
  const head = new TextDecoder("latin1").decode(body.subarray(0, 1024));
  const label =
    contentType.match(/charset\s*=\s*"?([\w.:-]+)/i)?.[1] ??
    head.match(/<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i)?.[1] ??
    head.match(/<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i)?.[1] ??
    "utf-8";
  try {
    return new TextDecoder(label).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}
