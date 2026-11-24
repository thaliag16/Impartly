// Gmail implementation of the read-only mail adapter (lib/mail/types.ts).
//
// Calls three Gmail REST endpoints, all GET: the mailbox profile, the message list and
// one message in full. Every request goes through gmailGet, which refuses any other
// method or path before anything is sent, so this adapter cannot change a mailbox even
// by mistake. lib/mail/mail-boundary.test.ts checks this file and the rest of the repo.
//
// Plain fetch, no Google SDK (googleapis is very large for three GETs). fetch is
// injectable so tests run against invented fixture JSON in Gmail's exact response shape.

import { KEPT_HEADERS, MailAuthError, type ListOptions, type MailAdapter, type MailMessage } from "../types";
import type { AccessTokenSource } from "../token-session";

export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

const MESSAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The only requests this adapter can make (path after /users/me). */
const ALLOWED_PATHS = [/^\/profile$/, /^\/messages$/, /^\/messages\/[A-Za-z0-9_-]{1,64}$/];

/** Throws unless this is a GET to one of the allowed read-only Gmail endpoints. */
export function assertReadOnlyRequest(method: string, url: string): void {
  if (method !== "GET") throw new Error(`Gmail adapter refused a ${method} request: read-only`);
  const parsed = new URL(url);
  const base = new URL(GMAIL_API_BASE);
  if (parsed.origin !== base.origin || !parsed.pathname.startsWith(base.pathname)) {
    throw new Error("Gmail adapter refused a request outside the Gmail API");
  }
  const rest = parsed.pathname.slice(base.pathname.length);
  if (!ALLOWED_PATHS.some((re) => re.test(rest))) {
    throw new Error("Gmail adapter refused a request to an endpoint it does not use: read-only");
  }
}

// ---- Gmail response shapes (the fields we read) ------------------------------------------

export interface GmailHeader {
  name: string;
  value: string;
}
export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}
export interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GmailPart;
}
interface GmailList {
  messages?: { id: string; threadId?: string }[];
  nextPageToken?: string;
}

// ---- Parsing -----------------------------------------------------------------------------

function header(headers: GmailHeader[] | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers?.find((h) => h.name.toLowerCase() === lower)?.value;
}

function charsetOf(part: GmailPart): string {
  const contentType = header(part.headers, "Content-Type") ?? "";
  const m = contentType.match(/charset\s*=\s*"?([^";\s]+)"?/i);
  return m ? m[1].toLowerCase() : "utf-8";
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Gmail body data: base64url, with or without padding. Already transfer-decoded by Gmail. */
export function decodeBodyData(data: string, charset = "utf-8"): string {
  const bytes = Buffer.from(data.replace(/=+$/, ""), "base64url");
  return decodeBytes(bytes, charset);
}

/** RFC 2047 encoded words in headers ("=?UTF-8?B?...?="). Plain values pass through. */
export function decodeHeaderWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[bq]\?[^?]*\?=)\s+(?==\?)/gi, "$1")
    .replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, charset: string, enc: string, text: string) => {
      let bytes: Uint8Array;
      if (enc.toLowerCase() === "b") bytes = Buffer.from(text, "base64");
      else {
        const qp = text.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
        bytes = Buffer.from(qp, "latin1");
      }
      return decodeBytes(bytes, charset.toLowerCase());
    });
}

/** "Name <addr@x>" / "<addr@x>" / "addr@x" to { address, name }. */
export function parseFrom(value: string): { address: string; name?: string } {
  const decoded = decodeHeaderWords(value).trim();
  const angle = decoded.match(/^(.*?)<([^<>]+)>\s*$/);
  if (angle) {
    const name = angle[1].trim().replace(/^"(.*)"$/, "$1").trim();
    return { address: angle[2].trim().toLowerCase(), ...(name ? { name } : {}) };
  }
  return { address: decoded.toLowerCase() };
}

function isAttachment(part: GmailPart): boolean {
  if (part.filename) return true;
  if (part.body?.attachmentId) return true;
  return /^\s*attachment/i.test(header(part.headers, "Content-Disposition") ?? "");
}

/** First text/html and first text/plain body, walking nested multipart parts. */
function findBodies(part: GmailPart | undefined, out: { html?: string; text?: string } = {}) {
  if (!part) return out;
  const type = (part.mimeType ?? "").toLowerCase();
  if (type.startsWith("multipart/")) {
    for (const child of part.parts ?? []) findBodies(child, out);
    return out;
  }
  if (isAttachment(part) || !part.body?.data) return out;
  if (type === "text/html" && out.html === undefined) out.html = decodeBodyData(part.body.data, charsetOf(part));
  if (type === "text/plain" && out.text === undefined) out.text = decodeBodyData(part.body.data, charsetOf(part));
  return out;
}

const BULK_LABELS = new Set(["CATEGORY_PROMOTIONS", "CATEGORY_UPDATES"]);

export function parseGmailMessage(raw: GmailMessage): MailMessage {
  const headers = raw.payload?.headers;
  const kept: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const value = header(headers, name);
    if (value !== undefined) kept[name] = value;
  }
  const internal = Number(raw.internalDate);
  const dateHeader = header(headers, "Date");
  const received = Number.isFinite(internal) && internal > 0 ? internal : Date.parse(dateHeader ?? "");
  if (!Number.isFinite(received)) throw new Error("Gmail message has no usable date");
  const bodies = findBodies(raw.payload);
  return {
    id: raw.id,
    from: parseFrom(header(headers, "From") ?? ""),
    subject: decodeHeaderWords(header(headers, "Subject") ?? "").trim(),
    receivedAt: new Date(received).toISOString(),
    headers: kept,
    bulkCategory: (raw.labelIds ?? []).some((l) => BULK_LABELS.has(l)),
    ...bodies,
  };
}

// ---- Adapter -----------------------------------------------------------------------------

export interface GmailAdapterOptions {
  tokens: AccessTokenSource;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Messages fetched in parallel. Default 4. */
  concurrency?: number;
}

export function createGmailAdapter(options: GmailAdapterOptions): MailAdapter {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const concurrency = Math.max(1, options.concurrency ?? 4);

  async function gmailGet<R>(path: string, params: Record<string, string> = {}): Promise<R> {
    const url = new URL(GMAIL_API_BASE + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    assertReadOnlyRequest("GET", url.toString());

    const request = async (token: string) =>
      doFetch(url.toString(), {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });

    let response = await request(await options.tokens.get());
    if (response.status === 401) {
      // Expired or revoked access token: refresh once and retry once.
      response = await request(await options.tokens.refresh());
      if (response.status === 401) {
        throw new MailAuthError("Gmail refused the refreshed token (HTTP 401); the user must reconnect");
      }
    }
    if (!response.ok) {
      // Status only: error bodies are not needed and may echo request details.
      throw new Error(`Gmail request failed with HTTP ${response.status}`);
    }
    return (await response.json()) as R;
  }

  async function getMessage(id: string): Promise<MailMessage> {
    if (!MESSAGE_ID.test(id)) throw new Error("Gmail returned an unexpected message id");
    const raw = await gmailGet<GmailMessage>(`/messages/${id}`, { format: "full" });
    return parseGmailMessage(raw);
  }

  return {
    provider: "gmail",

    async accountAddress() {
      const profile = await gmailGet<{ emailAddress?: string }>("/profile");
      if (!profile.emailAddress) throw new Error("Gmail profile had no address");
      return profile.emailAddress.toLowerCase();
    },

    async listMessagesSince(since: Date, listOptions: ListOptions = {}) {
      const limit = Math.max(1, Math.min(listOptions.limit ?? 200, 500));
      const sinceMs = since.getTime();
      if (!Number.isFinite(sinceMs)) throw new Error("since must be a valid date");

      // after: takes epoch seconds. Chats, sent mail and drafts are never newsletters.
      // Spam and trash are excluded by Gmail by default.
      const q = `after:${Math.floor(sinceMs / 1000)} -in:chats -in:sent -in:drafts`;
      const ids: string[] = [];
      let pageToken: string | undefined;
      do {
        const page = await gmailGet<GmailList>("/messages", {
          q,
          maxResults: String(Math.min(100, limit - ids.length)),
          ...(pageToken ? { pageToken } : {}),
        });
        for (const m of page.messages ?? []) if (!ids.includes(m.id)) ids.push(m.id);
        pageToken = page.nextPageToken;
      } while (pageToken && ids.length < limit);

      const messages: MailMessage[] = [];
      const queue = ids.slice(0, limit);
      const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
          messages.push(await getMessage(id));
        }
      });
      await Promise.all(workers);

      return messages
        .filter((m) => Date.parse(m.receivedAt) >= sinceMs)
        .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
    },
  };
}
