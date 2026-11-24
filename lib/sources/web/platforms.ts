// Newsletter hosting platforms whose public conventions discovery can use. Only beehiiv
// for now. Detection only steers which same-site public pages are tried (and in what
// order); every request still goes through the polite fetcher (robots.txt, SSRF checks,
// limits), sign-in and subscribe pages are never fetched, and nothing gets around a
// paywall. A page that wrongly looks like beehiiv costs at most a few extra requests.
//
// beehiiv conventions (public pages only):
//   * issues live at /p/<slug> on the publication's own host (custom domain or
//     <name>.beehiiv.com);
//   * /archive lists the issues;
//   * /sitemap.xml lists the issues with dates, whether or not robots.txt advertises it;
//   * when the publisher has switched RSS on, the feed is at
//     https://rss.beehiiv.com/feeds/<id>.xml, usually linked from the page (an RSS link or
//     <link rel="alternate">). Its id cannot be guessed, so it is only used when linked.
//   * pages load their images and scripts from media.beehiiv.com / embeds.beehiiv.com.

import { parse, type DefaultTreeAdapterTypes as T } from "parse5";
import { LIMITS } from "./fetcher";

export type Platform = "beehiiv";

/** beehiiv issue URLs: /p/<slug> (one segment, optional trailing slash). */
export const BEEHIIV_ISSUE_PATH = /^\/p\/[^/]+\/?$/;
export const BEEHIIV_ARCHIVE_PATH = "/archive";
export const BEEHIIV_SITEMAP_PATH = "/sitemap.xml";

const BEEHIIV_ASSET_HOSTS = new Set(["media.beehiiv.com", "embeds.beehiiv.com", "beehiiv-images-production.s3.amazonaws.com"]);
const BEEHIIV_FEED = /^https:\/\/rss\.beehiiv\.com\/feeds\/[A-Za-z0-9_-]{1,100}\.xml$/;

function* elements(node: T.ParentNode): Generator<T.Element> {
  for (const child of node.childNodes) {
    if (!("tagName" in child)) continue;
    yield child;
    if ("childNodes" in child) yield* elements(child as T.ParentNode);
  }
}

const attr = (el: T.Element, name: string) => el.attrs.find((a) => a.name === name)?.value?.trim() ?? "";

function hostOf(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The hosting platform of a fetched HTML page, from its URL (a *.beehiiv.com host), its
 * generator tag, or assets loaded from beehiiv's hosts. Text on the page never counts, and
 * neither does a plain link to beehiiv's homepage ("Powered by beehiiv").
 */
export function detectPlatform(html: string, pageUrl: string): Platform | null {
  const pageHost = hostOf(pageUrl);
  if (pageHost && pageHost.endsWith(".beehiiv.com")) return "beehiiv";
  for (const el of elements(parse(html.slice(0, LIMITS.pageBytes)))) {
    if (el.tagName === "meta" && attr(el, "name").toLowerCase() === "generator" && /^beehiiv\b/i.test(attr(el, "content"))) return "beehiiv";
    const src = el.tagName === "img" || el.tagName === "script" ? attr(el, "src") : el.tagName === "link" ? attr(el, "href") : "";
    const host = src ? hostOf(src) : null;
    if (host && BEEHIIV_ASSET_HOSTS.has(host)) return "beehiiv";
  }
  return null;
}

/** Links on the page to the publication's rss.beehiiv.com feed (https, /feeds/<id>.xml only). */
export function beehiivFeedLinks(html: string): string[] {
  const out: string[] = [];
  for (const el of elements(parse(html.slice(0, LIMITS.pageBytes)))) {
    if (el.tagName !== "a" && el.tagName !== "link") continue;
    const href = attr(el, "href");
    if (BEEHIIV_FEED.test(href)) out.push(href);
  }
  return [...new Set(out)];
}
