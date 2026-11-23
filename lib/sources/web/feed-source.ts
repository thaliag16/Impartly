// A public web feed (RSS or Atom) as a NewsletterSource.
//
// One pull is one conditional GET of the feed URL (If-None-Match / If-Modified-Since from
// the last pull; a 304 reads nothing). Items are de-duplicated by guid/id, else link
// (the pipeline's store ignores a key it already has), turned into visible text by the
// shared HTML to text step (hidden-text stripping applies to web content too), and
// filtered by date.
//
// Paywalls and sign-ins are respected, never worked around: only what the feed itself
// publishes is read. The item's own page is never fetched to "complete" a teaser. An item
// that is only an excerpt or carries a paywall notice is marked `partial`, and what is
// public is summarized.

import { createHash } from "node:crypto";
import { htmlToText, plainTextToText } from "../../text/html-to-text";
import { SourceFetchError, type NewsletterSource, type PullResult, type SourceItem } from "../types";
import { LIMITS, type WebFetcher } from "./fetcher";
import { parseFeed, type FeedItem } from "./feed-parser";

export const FEED_ACCEPT =
  "application/rss+xml, application/atom+xml, application/rdf+xml;q=0.9, application/xml;q=0.8, text/xml;q=0.8, */*;q=0.1";

/** Below this many characters, an item with no full content is treated as an excerpt. */
export const EXCERPT_MAX_CHARS = 1000;

const PAYWALL =
  /\b(?:(?:subscribe|upgrade|sign in|log in|become a (?:paid )?(?:subscriber|member))(?: now)? to (?:continue|keep) reading|keep reading with a \d+-day free trial|this (?:post|article|story|issue|newsletter|edition) is (?:only )?(?:for|available to) (?:paid|paying|premium) (?:subscribers|members)|(?:paid|premium) subscribers only|subscribers only|members only|read the full (?:story|article|issue|post) (?:on|at)|continue reading (?:on|at) )/i;
const TRUNCATED_END = /(?:…|\.\.\.|\[…\]|\[\.\.\.\]|\bread more|\bcontinue reading|\bread the rest)\s*[.»›>)\]]*\s*$/i;

export interface StoredFeed {
  id: string;
  feedUrl: string;
  title: string | null;
  etag: string | null;
  lastModified: string | null;
}

/** Whether only part of the issue is public. */
export function isPartial(item: FeedItem, text: string): boolean {
  if (PAYWALL.test(text)) return true;
  if (TRUNCATED_END.test(text)) return true;
  if (!item.content && text.length < EXCERPT_MAX_CHARS) return true;
  return false;
}

function toText(part: { value: string; type: "html" | "text" }, maxChars: number) {
  return part.type === "html" ? htmlToText(part.value, { maxChars }) : plainTextToText(part.value, { maxChars });
}

export function itemKey(item: FeedItem): string {
  if (item.id) return `id:${item.id.slice(0, 500)}`;
  if (item.link) return `link:${item.link.slice(0, 500)}`;
  const h = createHash("sha256").update(`${item.title}\n${item.published ?? ""}\n${item.summary?.value ?? ""}`);
  return `hash:${h.digest("hex")}`;
}

export function feedSenderAddress(feedUrl: string): string {
  return new URL(feedUrl).hostname.toLowerCase().replace(/^www\./, "");
}

export function webFeedSource(feed: StoredFeed, fetcher: WebFetcher, now: () => Date = () => new Date()): NewsletterSource {
  return {
    kind: "web",
    id: feed.id,
    async pull({ since, limit, maxChars, firstPull }): Promise<PullResult> {
      const res = await fetcher.get(feed.feedUrl, {
        accept: FEED_ACCEPT,
        maxBytes: LIMITS.feedBytes,
        etag: feed.etag,
        lastModified: feed.lastModified,
      });
      if (res.status === 304) {
        return {
          items: [],
          listed: 0,
          capped: false,
          cache: { etag: feed.etag, lastModified: feed.lastModified, notModified: true },
        };
      }
      if (res.status !== 200) throw new SourceFetchError(`http_${res.status}`);
      const parsed = parseFeed(res.text, res.url.toString());
      if (!parsed) throw new SourceFetchError("not_a_feed");

      const senderAddress = feedSenderAddress(feed.feedUrl);
      const senderName = (feed.title || parsed.title || senderAddress).slice(0, 200);
      const fetchedAt = now().toISOString();
      const items: SourceItem[] = [];
      const seen = new Set<string>();
      let capped = false;
      let undatedTaken = 0;

      // Newest first; undated items keep their feed order after the dated ones.
      const ordered = parsed.items
        .map((item, index) => ({ item, index }))
        .sort((a, b) => {
          const ta = a.item.published ? Date.parse(a.item.published) : -Infinity;
          const tb = b.item.published ? Date.parse(b.item.published) : -Infinity;
          return tb - ta || a.index - b.index;
        });

      for (const { item } of ordered) {
        const key = itemKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        if (item.published) {
          if (Date.parse(item.published) < since.getTime()) continue;
        } else if (firstPull && undatedTaken >= 1) {
          // With no dates, a first pull cannot tell new from old: take only the top item.
          continue;
        }
        const part = item.content ?? item.summary;
        const { text, truncated } = part ? toText(part, maxChars) : { text: "", truncated: false };
        if (!text) continue;
        if (items.length >= limit) {
          capped = true;
          break;
        }
        if (!item.published) undatedTaken++;
        items.push({
          key,
          senderAddress,
          senderName,
          subject: htmlToText(item.title, { maxChars: 500 }).text.replace(/\s+/g, " "),
          receivedAt: item.published ?? fetchedAt,
          bodyText: text,
          truncated,
          partial: isPartial(item, text),
          url: item.link,
        });
      }

      return {
        items,
        listed: parsed.items.length,
        capped,
        cache: {
          etag: res.headers["etag"]?.slice(0, 512) ?? null,
          lastModified: res.headers["last-modified"]?.slice(0, 100) ?? null,
          notModified: false,
        },
      };
    },
  };
}
