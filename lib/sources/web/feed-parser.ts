// RSS and Atom parsing: RSS 2.0 (and 0.9x), RSS 1.0 (RDF) and Atom 1.0.
//
// XML is read with saxes, a strict SAX parser that never fetches external entities and
// never expands entities declared in a DOCTYPE (no XXE, no "billion laughs"). Feeds in the
// wild are often slightly malformed (a bare "&", an HTML entity like &nbsp;), so parse
// errors are counted, not fatal: an unknown entity stays as literal text (the HTML to
// text step decodes it later), and the document is rejected only if no feed root is found.
//
// Item bodies: RSS content:encoded is the full issue when present; description is often
// a teaser. Atom content beats summary. Both are kept so the caller can tell a full issue
// from an excerpt (feed-source.ts). Every string here is untrusted.

import { SaxesParser } from "saxes";

export type FeedFormat = "rss" | "atom";

export interface FeedItem {
  /** guid (RSS) or id (Atom), if present. */
  id?: string;
  /** The item's link, resolved against the feed URL. */
  link?: string;
  title: string;
  /** ISO 8601, if the item had a parseable date. */
  published?: string;
  /** Full content: RSS content:encoded, Atom content. */
  content?: { value: string; type: "html" | "text" };
  /** Short form: RSS description, Atom summary. */
  summary?: { value: string; type: "html" | "text" };
}

export interface ParsedFeed {
  format: FeedFormat;
  title: string;
  /** The site the feed belongs to (RSS channel link, Atom alternate link), if given. */
  siteUrl?: string;
  items: FeedItem[];
}

interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: (XNode | string)[];
}

const MAX_ERRORS = 200;
const MAX_ITEMS = 200;

/**
 * Escapes a bare "&" (one that does not start an entity or character reference) outside
 * CDATA sections. Without this a strict parser reads "Bits & Bobs</title>..." as one
 * long, broken entity name and loses the rest of the element.
 */
export function escapeBareAmpersands(xml: string): string {
  return xml
    .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
    .map((part, i) =>
      i % 2 === 1 ? part : part.replace(/&(?!(?:[A-Za-z_][A-Za-z0-9._-]{0,31}|#[0-9]{1,7}|#x[0-9A-Fa-f]{1,6});)/g, "&amp;"),
    )
    .join("");
}

function buildTree(rawXml: string): XNode | null {
  const xml = escapeBareAmpersands(rawXml);
  const parser = new SaxesParser({ xmlns: false });
  const root: XNode = { name: "#document", attrs: {}, children: [] };
  const stack: XNode[] = [root];
  let errors = 0;
  parser.on("error", () => {
    errors++;
    if (errors > MAX_ERRORS) throw new Error("too many XML errors");
  });
  parser.on("opentag", (tag) => {
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(tag.attributes)) attrs[k.toLowerCase()] = String(v);
    const node: XNode = { name: tag.name.toLowerCase(), attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!tag.isSelfClosing) stack.push(node);
  });
  parser.on("closetag", (tag) => {
    if (tag.isSelfClosing) return;
    // Pop to the matching element (tolerates a stray close tag).
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i].name === tag.name.toLowerCase()) {
        stack.length = i;
        return;
      }
    }
  });
  const text = (t: string) => stack[stack.length - 1].children.push(t);
  parser.on("text", text);
  parser.on("cdata", text);
  try {
    parser.write(xml).close();
  } catch {
    return null;
  }
  return root;
}

const kids = (n: XNode | undefined, name: string): XNode[] =>
  (n?.children.filter((c) => typeof c !== "string" && c.name === name) as XNode[]) ?? [];
const kid = (n: XNode | undefined, ...names: string[]): XNode | undefined => {
  for (const name of names) {
    const found = kids(n, name)[0];
    if (found) return found;
  }
  return undefined;
};
const textOf = (n: XNode | undefined): string =>
  n ? n.children.map((c) => (typeof c === "string" ? c : textOf(c))).join("") : "";

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Atom type="xhtml" content is inline markup: serialize it back to HTML. */
function serialize(n: XNode): string {
  return n.children
    .map((c) => {
      if (typeof c === "string") return escapeXml(c);
      const name = c.name.replace(/^[a-z0-9]+:/, "");
      const attrs = Object.entries(c.attrs)
        .filter(([k]) => !k.startsWith("xmlns"))
        .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
        .join("");
      return `<${name}${attrs}>${serialize(c)}</${name}>`;
    })
    .join("");
}

function atomText(n: XNode | undefined): { value: string; type: "html" | "text" } | undefined {
  if (!n) return undefined;
  const type = (n.attrs.type ?? "text").toLowerCase();
  if (type === "xhtml") return { value: serialize(n), type: "html" };
  if (type === "html" || type === "text/html") return { value: textOf(n), type: "html" };
  if (type === "text" || type === "text/plain") return { value: textOf(n), type: "text" };
  return undefined; // other media types (base64 etc.) are not read
}

function toIso(value: string | undefined): string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

function resolveLink(href: string | undefined, base: string | undefined): string | undefined {
  const h = href?.trim();
  if (!h) return undefined;
  try {
    const u = new URL(h, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function atomLink(n: XNode, base: string | undefined): string | undefined {
  const links = kids(n, "link");
  const alt = links.find((l) => !l.attrs.rel || l.attrs.rel === "alternate") ?? undefined;
  return resolveLink(alt?.attrs.href, base);
}

function parseAtom(feed: XNode, base: string | undefined): ParsedFeed {
  return {
    format: "atom",
    title: oneLine(textOf(kid(feed, "title"))),
    siteUrl: atomLink(feed, base),
    items: kids(feed, "entry")
      .slice(0, MAX_ITEMS)
      .map((e) => ({
        id: oneLine(textOf(kid(e, "id"))) || undefined,
        link: atomLink(e, base),
        title: oneLine(textOf(kid(e, "title"))),
        published: toIso(textOf(kid(e, "published"))) ?? toIso(textOf(kid(e, "updated"))),
        content: atomText(kid(e, "content")),
        summary: atomText(kid(e, "summary")),
      })),
  };
}

function rssItem(i: XNode, base: string | undefined): FeedItem {
  const encoded = textOf(kid(i, "content:encoded"));
  const description = textOf(kid(i, "description"));
  return {
    id: oneLine(textOf(kid(i, "guid"))) || i.attrs["rdf:about"] || undefined,
    link: resolveLink(textOf(kid(i, "link")), base),
    title: oneLine(textOf(kid(i, "title"))),
    published: toIso(textOf(kid(i, "pubdate"))) ?? toIso(textOf(kid(i, "dc:date"))),
    content: encoded.trim() ? { value: encoded, type: "html" } : undefined,
    summary: description.trim() ? { value: description, type: "html" } : undefined,
  };
}

/** Parses RSS or Atom. Returns null if the document is not a feed. */
export function parseFeed(xml: string, baseUrl?: string): ParsedFeed | null {
  const doc = buildTree(xml);
  const root = doc?.children.find((c): c is XNode => typeof c !== "string");
  if (!root) return null;
  if (root.name === "feed") return parseAtom(root, baseUrl);
  if (root.name === "rss" || root.name === "rdf:rdf") {
    const channel = kid(root, "channel");
    if (!channel) return null;
    // RSS 2.0 puts items in the channel; RSS 1.0 (RDF) puts them next to it.
    const items = [...kids(channel, "item"), ...kids(root, "item")].slice(0, MAX_ITEMS);
    return {
      format: "rss",
      title: oneLine(textOf(kid(channel, "title"))),
      siteUrl: resolveLink(textOf(kid(channel, "link")), baseUrl),
      items: items.map((i) => rssItem(i, baseUrl)),
    };
  }
  return null;
}
