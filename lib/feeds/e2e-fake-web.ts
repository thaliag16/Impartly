// A fake internet for the picker's UI tests (e2e/newsletters.e2e.ts): a resolver and a
// transport for safeFetch that answer from the canned responses below and never open a
// socket. The real fetcher, robots.txt rules, address checks and feed parsing all still
// run on top of it.
//
// Used only when the server starts with IMPARTLY_E2E_FAKE_WEB=1 and is not on Vercel
// (lib/feeds/deps.ts). Every feed item here is invented; the site names match catalog
// entries so the catalog search can be tested, nothing else about those sites is real.

import type { Resolver, Transport } from "../sources/web/safe-fetch";

const rssFeed = (title: string, site: string, items: { title: string; date: string }[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>${title}</title><link>${site}</link><description>Invented test feed</description>
${items
  .map(
    (i, n) =>
      `<item><title>${i.title}</title><link>${site}invented-${n}</link><guid>${site}invented-${n}</guid><pubDate>${i.date}</pubDate><description>An invented issue used only in the UI tests. It has enough words to read as a full item rather than a teaser for the partial-issue rule, which looks at length and endings.</description></item>`,
  )
  .join("\n")}
</channel></rss>`;

const RSS = { "content-type": "application/rss+xml; charset=utf-8" };
const HTML = { "content-type": "text/html; charset=utf-8" };
const TEXT = { "content-type": "text/plain; charset=utf-8" };

type Canned = { status: number; headers?: Record<string, string>; body?: string };

const ROUTES: Record<string, Canned> = {
  "https://techcrunch.com/feed/": {
    status: 200,
    headers: RSS,
    body: rssFeed("TechCrunch", "https://techcrunch.com/", [
      { title: "Invented startup story", date: "Sun, 22 Nov 2026 15:30:00 GMT" },
      { title: "Another invented story", date: "Sat, 21 Nov 2026 09:00:00 GMT" },
    ]),
  },
  "https://strictlyvc.com/": {
    status: 200,
    headers: HTML,
    body: '<!doctype html><html><head><title>StrictlyVC</title><link rel="alternate" type="application/rss+xml" href="/feed/"></head><body>Invented</body></html>',
  },
  "https://strictlyvc.com/feed/": {
    status: 200,
    headers: RSS,
    body: rssFeed("StrictlyVC", "https://strictlyvc.com/", [{ title: "Invented venture issue", date: "Fri, 20 Nov 2026 13:00:00 GMT" }]),
  },
  "https://www.morningbrew.com/": { status: 200, headers: HTML, body: "<!doctype html><html><head><title>Invented</title></head><body>No feed link</body></html>" },
  "https://www.morningbrew.com/feed.xml": {
    status: 200,
    headers: RSS,
    body: rssFeed("Morning Brew", "https://www.morningbrew.com/", [{ title: "Invented morning issue", date: "Mon, 23 Nov 2026 11:00:00 GMT" }]),
  },
  "https://robots-blocked.example/robots.txt": { status: 200, headers: TEXT, body: "User-agent: *\nDisallow: /\n" },
  "https://no-feed.example/": { status: 200, headers: HTML, body: "<!doctype html><html><head><title>Invented</title></head><body>No feed here</body></html>" },
  "https://refused.example/": { status: 403, headers: HTML, body: "Forbidden" },
  // No feed anywhere: its homepage lists issues, so discovery offers the archive fallback.
  "https://archive-only.example/": {
    status: 200,
    headers: HTML,
    body: `<!doctype html><html><head><title>Home</title><meta property="og:site_name" content="Invented Archive Weekly"></head><body>
<nav><a href="/about">About this invented newsletter</a><a href="/subscribe">Subscribe to the invented list</a></nav>
<main><h1>Past issues</h1>
<article><h2><a href="/issues/42-invented-robots">Issue 42: Invented robots raise a round</a></h2><time datetime="2026-11-22T08:00:00Z">Nov 22</time></article>
<article><h2><a href="/issues/41-invented-chips">Issue 41: Invented chips get cheaper</a></h2><time datetime="2026-11-15T08:00:00Z">Nov 15</time></article>
<article><h2><a href="https://elsewhere.example/sponsored">A sponsor on another site</a></h2></article>
</main></body></html>`,
  },
};

/** Names that resolve to a private address, to show the address check still applies. */
const PRIVATE_NAMES: Record<string, string> = { "intranet.example": "10.0.0.5" };

export const fakeResolve: Resolver = async (hostname) => {
  const address = PRIVATE_NAMES[hostname] ?? "93.184.215.14";
  return [{ address, family: 4 }];
};

export const fakeTransport: Transport = async ({ url }) => {
  const route = ROUTES[url.toString()] ?? { status: 404, headers: TEXT, body: "Not found" };
  const body = new TextEncoder().encode(route.body ?? "");
  return {
    status: route.status,
    headers: Object.fromEntries(Object.entries(route.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    body: (async function* () {
      yield body;
    })(),
  };
};

/** Only with IMPARTLY_E2E_FAKE_WEB=1, and never on Vercel. */
export function fakeWebEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.IMPARTLY_E2E_FAKE_WEB === "1" && !env.VERCEL;
}
