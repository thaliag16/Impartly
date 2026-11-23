// Picking a newsletter: discover its public feed (discover.ts), then store it for the user
// (web_feeds, through the server-only feeds_subscribe function). Only a URL that answered
// with a valid feed is stored, never the user's raw input.

import type { Rpc } from "../../mail";
import type { CatalogEntry } from "./catalog";
import { discoverFeed, type DiscoveredFeed, type DiscoveryResult } from "./discover";
import type { WebFetcher } from "./fetcher";

export type SubscribeResult =
  | { ok: true; feedId: string; inserted: boolean; feed: DiscoveredFeed }
  | Extract<DiscoveryResult, { ok: false }>;

export async function subscribeToNewsletter(
  userId: string,
  input: string,
  deps: { rpc: Rpc; fetcher: WebFetcher; catalog?: readonly CatalogEntry[] },
): Promise<SubscribeResult> {
  const found = await discoverFeed(input, deps.fetcher, deps.catalog ?? []);
  if (!found.ok) return found as Extract<DiscoveryResult, { ok: false }>;
  const raw = (await deps.rpc("feeds_subscribe", {
    p_user_id: userId,
    p_feed_url: found.feed.feedUrl,
    p_feed_format: found.feed.format,
    p_title: found.feed.title,
    p_homepage_url: found.feed.homepageUrl,
    p_catalog_id: found.feed.catalogId,
  })) as { id?: unknown; inserted?: unknown } | null;
  if (!raw || typeof raw.id !== "string") throw new Error("feeds_subscribe returned no id");
  return { ok: true, feedId: raw.id, inserted: raw.inserted === true, feed: found.feed };
}
