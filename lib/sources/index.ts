// The source layer: one interface (types.ts) for every place newsletters come from.
// Web feeds the user picks (web/) are the main source; a connected mailbox (mail.ts) is
// optional. Forwarding and iPhone mail access will be further implementations.

export * from "./types";
export { mailSource } from "./mail";
export { webFeedSource, isPartial, itemKey, FEED_ACCEPT, type StoredFeed } from "./web/feed-source";
export { parseFeed, type ParsedFeed, type FeedItem, type FeedFormat } from "./web/feed-parser";
export { createWebFetcher, USER_AGENT, REPO_URL, type WebFetcher } from "./web/fetcher";
export { discoverFeed, type DiscoveredFeed, type DiscoveryResult, type SourceFormat } from "./web/discover";
export { webArchiveSource, createPacer, ARCHIVE_LIMITS, type StoredArchive, type Pacer } from "./web/archive-source";
export { extractIssue, issueLinksFromIndex, parseSitemap, normalizeUrl } from "./web/archive";
export { loadCatalog, catalogLookup, searchCatalog, type CatalogEntry } from "./web/catalog";
export { subscribeToNewsletter, type SubscribeResult } from "./web/subscribe";
export { isPublicAddress } from "./web/address-policy";
