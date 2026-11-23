// SSRF protection and fetch limits. A server that fetches user-supplied URLs is a security
// boundary, so each rule here is tested on its own: blocked address ranges (checked after
// DNS), blocked names, schemes, ports, credentials, redirects (each hop re-checked),
// size limits before and after decompression, the deadline, and the real Node transport
// connecting to the checked address only.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeWeb, PUBLIC_V4 } from "../../../tests/web/fake-web";
import { SourceFetchError } from "../types";
import { isBlockedHostname, isPublicAddress, parseIPv6 } from "./address-policy";
import { checkUrl, decodeBody, nodeTransport, safeFetch, type SafeFetchOptions, type Transport } from "./safe-fetch";

const OPTS: SafeFetchOptions = { maxBytes: 64 * 1024, timeoutMs: 2_000, maxRedirects: 3 };

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof SourceFetchError) return err.code;
    throw err;
  }
  return "no error";
}

describe("address policy", () => {
  it.each([
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.254", "127.0.0.1", "127.1.2.3",
    "169.254.169.254", "169.254.0.1", "172.16.0.1", "172.31.255.255", "192.0.0.8", "192.0.2.1", "192.88.99.1",
    "192.168.1.1", "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250",
    "240.0.0.1", "255.255.255.255",
  ])("blocks IPv4 %s", (a) => expect(isPublicAddress(a)).toBe(false));

  it.each([
    "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "::ffff:8.8.8.8", "::127.0.0.1",
    "64:ff9b::7f00:1", "64:ff9b:1::1", "100::1", "2001::1", "2001:db8::1", "2002:7f00:1::1", "3fff::1", "fc00::1",
    "fd12:3456::1", "fe80::1", "fe80::1%eth0", "fec0::1", "ff02::1", "fd00:ec2::254",
  ])("blocks IPv6 %s", (a) => expect(isPublicAddress(a)).toBe(false));

  it.each(["8.8.8.8", "1.1.1.1", "93.184.215.14", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001::1"])(
    "allows public %s",
    (a) => expect(isPublicAddress(a)).toBe(true),
  );

  it("refuses anything that is not an IP address", () => {
    for (const a of ["", "localhost", "1.2.3", "1.2.3.4.5", "::g", "example.com"]) expect(isPublicAddress(a)).toBe(false);
  });

  it("expands IPv6 correctly, including embedded IPv4", () => {
    expect(parseIPv6("::ffff:127.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(parseIPv6("2001:db8::")).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
    expect(parseIPv6("nope")).toBeNull();
  });

  it.each(["localhost", "LOCALHOST.", "app.localhost", "printer.local", "db.internal", "metadata.google.internal", "router.lan", "nas.home.arpa", "intranet", ""])(
    "blocks host name %j",
    (h) => expect(isBlockedHostname(h)).toBe(true),
  );

  it("allows ordinary public names", () => {
    for (const h of ["news.example", "www.techcrunch.com", "a.b.c.example"]) expect(isBlockedHostname(h)).toBe(false);
  });
});

describe("URL checks", () => {
  it.each([
    ["file:///etc/passwd", "unsupported_scheme"],
    ["ftp://news.example/feed", "unsupported_scheme"],
    ["gopher://news.example/", "unsupported_scheme"],
    ["javascript:alert(1)", "unsupported_scheme"],
    ["data:text/xml,<rss/>", "unsupported_scheme"],
    ["https://user:pass@news.example/feed", "credentials_in_url"],
    ["https://news.example:8443/feed", "unsupported_port"],
    ["http://news.example:22/", "unsupported_port"],
    ["https://news.example:80/", "unsupported_port"],
    ["http://127.0.0.1/", "blocked_address"],
    ["http://2130706433/", "blocked_address"], // decimal 127.0.0.1
    ["http://0x7f.1/", "blocked_address"], // hex shorthand
    ["http://0177.0.0.1/", "blocked_address"], // octal
    ["http://[::1]/", "blocked_address"],
    ["http://[::ffff:169.254.169.254]/latest/meta-data/", "blocked_address"],
    ["http://169.254.169.254/latest/meta-data/", "blocked_address"],
    ["http://localhost/", "blocked_host"],
    ["http://metadata.google.internal/", "blocked_host"],
    ["not a url", "invalid_url"],
  ])("refuses %s", (url, expected) => {
    expect(() => checkUrl(url)).toThrow(SourceFetchError);
    try {
      checkUrl(url);
    } catch (err) {
      expect((err as SourceFetchError).code).toBe(expected);
    }
  });

  it("accepts http(s) on default ports and drops the fragment", () => {
    expect(checkUrl("https://news.example:443/feed#x").toString()).toBe("https://news.example/feed");
    expect(checkUrl("http://news.example/feed").protocol).toBe("http:");
  });
});

describe("safeFetch with a fake network", () => {
  it("checks the address AFTER DNS: a public-looking name that resolves privately is refused before any request", async () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1", "fd00::5", "::ffff:192.168.0.1"]) {
      const web = createFakeWeb({ dns: { "rebind.example": [address] }, routes: { "https://rebind.example/feed": { body: "x" } } });
      expect(await code(safeFetch("https://rebind.example/feed", OPTS, web))).toBe("blocked_address");
      expect(web.requests).toHaveLength(0);
    }
  });

  it("refuses a name with ANY private address among its answers", async () => {
    const web = createFakeWeb({ dns: { "mixed.example": [PUBLIC_V4, "127.0.0.1"] } });
    expect(await code(safeFetch("https://mixed.example/", OPTS, web))).toBe("blocked_address");
    expect(web.requests).toHaveLength(0);
  });

  it("connects to the address it checked, and keeps the host name for Host and TLS", async () => {
    const web = createFakeWeb({ routes: { "https://news.example/feed": { body: "ok" } } });
    const res = await safeFetch("https://news.example/feed", OPTS, web);
    expect(res.status).toBe(200);
    expect(web.requests[0].address).toEqual({ address: PUBLIC_V4, family: 4 });
    expect(web.requests[0].url.hostname).toBe("news.example");
  });

  it("re-checks every redirect hop: a redirect to a private address or local name is refused", async () => {
    for (const location of [
      "http://127.0.0.1/admin",
      "http://169.254.169.254/latest/meta-data/",
      "http://localhost:8080/",
      "https://inside.example/",
      "file:///etc/passwd",
    ]) {
      const web = createFakeWeb({
        dns: { "inside.example": ["192.168.1.10"] },
        routes: { "https://news.example/feed": { status: 302, headers: { location } } },
      });
      const c = await code(safeFetch("https://news.example/feed", OPTS, web));
      expect(["blocked_address", "blocked_host", "unsupported_port", "unsupported_scheme"]).toContain(c);
      expect(web.requests).toHaveLength(1);
    }
  });

  it("follows a few redirects, then stops", async () => {
    const web = createFakeWeb({
      routes: {
        "https://a.example/": { status: 301, headers: { location: "https://b.example/" } },
        "https://b.example/": { status: 308, headers: { location: "/c" } },
        "https://b.example/c": { status: 200, body: "done" },
      },
    });
    const res = await safeFetch("https://a.example/", OPTS, web);
    expect(res.url.toString()).toBe("https://b.example/c");
    expect(res.redirects).toBe(2);

    const loop = createFakeWeb({ routes: { "https://loop.example/": { status: 302, headers: { location: "/" } } } });
    expect(await code(safeFetch("https://loop.example/", OPTS, loop))).toBe("too_many_redirects");
    expect(loop.requests).toHaveLength(OPTS.maxRedirects + 1);
  });

  it("never steps down from https to http", async () => {
    const web = createFakeWeb({ routes: { "https://a.example/": { status: 302, headers: { location: "http://a.example/" } } } });
    expect(await code(safeFetch("https://a.example/", OPTS, web))).toBe("insecure_redirect");
  });

  it("stops reading past maxBytes", async () => {
    const web = createFakeWeb({ routes: { "https://big.example/": { body: new Uint8Array(OPTS.maxBytes + 1) } } });
    expect(await code(safeFetch("https://big.example/", OPTS, web))).toBe("too_large");
  });

  it("limits the size AFTER decompression too (a small gzip cannot expand into a huge body)", async () => {
    const bomb = gzipSync(new Uint8Array(OPTS.maxBytes * 20));
    expect(bomb.length).toBeLessThan(OPTS.maxBytes);
    const web = createFakeWeb({ routes: { "https://bomb.example/": { headers: { "content-encoding": "gzip" }, body: bomb } } });
    expect(await code(safeFetch("https://bomb.example/", OPTS, web))).toBe("too_large");

    const ok = createFakeWeb({ routes: { "https://gz.example/": { headers: { "content-encoding": "gzip" }, body: gzipSync(Buffer.from("hello")) } } });
    expect(new TextDecoder().decode((await safeFetch("https://gz.example/", OPTS, ok)).body)).toBe("hello");
  });

  it("gives up at the deadline", async () => {
    const slow: Transport = ({ signal }) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    const web = createFakeWeb();
    expect(await code(safeFetch("https://slow.example/", { ...OPTS, timeoutMs: 50 }, { resolve: web.resolve, transport: slow }))).toBe("timeout");
  });

  it("lets beforeRequest refuse a hop (used for robots.txt)", async () => {
    const web = createFakeWeb({ routes: { "https://a.example/": { status: 302, headers: { location: "https://b.example/private" } } } });
    const seen: string[] = [];
    const c = await code(
      safeFetch(
        "https://a.example/",
        {
          ...OPTS,
          beforeRequest: async (u) => {
            seen.push(u.toString());
            if (u.hostname === "b.example") throw new SourceFetchError("robots_disallowed");
          },
        },
        web,
      ),
    );
    expect(c).toBe("robots_disallowed");
    expect(seen).toEqual(["https://a.example/", "https://b.example/private"]);
    expect(web.requests).toHaveLength(1);
  });

  it("a DNS failure is a short code, not an exception with the host in it", async () => {
    const web = createFakeWeb();
    expect(await code(safeFetch("https://unknown.invalid/", OPTS, web))).toBe("dns_failed");
  });
});

describe("decodeBody", () => {
  it("honours the BOM, the Content-Type charset and the XML declaration", () => {
    const latin1 = Uint8Array.from([0x63, 0x61, 0x66, 0xe9]); // "café" in ISO-8859-1
    expect(decodeBody(latin1, "text/xml; charset=ISO-8859-1")).toBe("café");
    const decl = new Uint8Array([...new TextEncoder().encode('<?xml version="1.0" encoding="iso-8859-1"?><a>'), 0xe9, ...new TextEncoder().encode("</a>")]);
    expect(decodeBody(decl)).toContain("é");
    expect(decodeBody(Uint8Array.from([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toBe("hi");
    expect(decodeBody(new TextEncoder().encode("ok"), "text/xml; charset=not-a-charset")).toBe("ok");
  });
});

describe("the real Node transport", () => {
  let server: Server;
  let port = 0;
  const hits: { host?: string; url?: string }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push({ host: req.headers.host, url: req.url });
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "http://elsewhere.example/" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/rss+xml", "content-encoding": "gzip", etag: '"v1"' });
      res.end(gzipSync(Buffer.from("<rss/>")));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  // The local test server listens on a random port; this rewrites only the port, so the
  // test still goes through nodeTransport's pinned lookup for a name that does not exist.
  const onTestPort: Transport = (req) => {
    const url = new URL(req.url);
    url.port = String(port);
    return nodeTransport({ ...req, url });
  };

  it("connects to the checked address even though the name does not resolve, and sends the original Host", async () => {
    const res = await safeFetch(
      "http://feeds.example/feed",
      OPTS,
      {
        resolve: async () => [{ address: "127.0.0.1", family: 4 }],
        transport: onTestPort,
        isAllowedAddress: (a) => a === "127.0.0.1", // tests only: allow the local server
      },
    );
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(res.body)).toBe("<rss/>");
    expect(res.headers.etag).toBe('"v1"');
    expect(hits.at(-1)).toEqual({ host: `feeds.example:${port}`, url: "/feed" });
  });

  it("with the default policy, a name resolving to the local server is refused and the server never sees it", async () => {
    const before = hits.length;
    const c = await code(
      safeFetch("http://feeds.example/feed", OPTS, { resolve: async () => [{ address: "127.0.0.1", family: 4 }], transport: onTestPort }),
    );
    expect(c).toBe("blocked_address");
    expect(hits.length).toBe(before);
  });

  it("does not follow redirects by itself", async () => {
    const res = await onTestPort({
      url: new URL("http://feeds.example/redirect"),
      address: { address: "127.0.0.1", family: 4 },
      headers: {},
      signal: new AbortController().signal,
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("http://elsewhere.example/");
  });
});
