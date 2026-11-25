// The pull-and-summarize pipeline end to end on a real Postgres: real migrations (with the
// Supabase and Vault stand-ins from tests/db/supabase-shim.sql), the real Vault token
// store, the real Gmail adapter against the fake Gmail API (invented fixtures), and a fake
// summarizer that records what it was given.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVaultTokenStore, gmailAdapterForConnection, type Rpc, type TokenStore } from "../../lib/mail";
import { createRpcPipelineStore, runPipelineForUser, type PipelineLimits, type PipelineStore } from "../../lib/pipeline";
import type { Newsletter, SummaryLength, SummaryProvider } from "../../lib/summarizer/types";
import { createFakeGoogle, type FakeGoogle } from "../mail/fake-gmail";
import { as, attempt, createTestDatabase, databaseUrl, type TestDatabase } from "./harness";

const NOW = new Date("2026-11-23T12:00:00.000Z"); // fixtures' "now" (scripts/build-gmail-fixtures.mjs)
const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const HIDDEN = /HIDDEN-MARKER|PLAINONLY-MARKER/;

// The fixture inbox, with the user's sources as in lib/mail/newsletters.test.ts: one known
// sender without list headers (included), one switched off, one already known.
const SOURCES = [
  ["almanac@tidewater.example", true],
  ["deals@gadget-deals.example", false],
  ["editor@harbor-notes.example", true],
] as const;
const EXPECTED_SENDERS = [
  "almanac@tidewater.example",
  "digest@quarry-ledger.example",
  "editor@harbor-notes.example",
  "lettre@cafe-lettre.example",
  "news@brightline-weekly.example",
];

interface FakeSummarizer extends SummaryProvider {
  calls: { input: Newsletter; length: SummaryLength }[];
  failSubjects: Set<string>;
}

function fakeSummarizer(): FakeSummarizer {
  const s: FakeSummarizer = {
    calls: [],
    failSubjects: new Set(),
    async summarize(input, { length }) {
      s.calls.push({ input, length });
      if (s.failSubjects.has(input.subject)) throw new Error("ProviderDown");
      return `A ${length} summary of ${input.subject}.`;
    },
  };
  return s;
}

describe.skipIf(!databaseUrl)("pipeline for one user, on real Postgres", () => {
  let db: TestDatabase;
  let rpc: Rpc;
  let tokens: TokenStore;
  let store: PipelineStore;

  interface TestUser {
    id: string;
    connectionId: string;
    google: FakeGoogle;
  }

  async function newUser(opts: { length?: SummaryLength } = {}): Promise<TestUser> {
    const id = randomUUID();
    await db.admin.query("insert into auth.users (id) values ($1)", [id]);
    if (opts.length) {
      await db.admin.query("insert into public.user_settings (user_id, summary_length) values ($1, $2)", [id, opts.length]);
    }
    for (const [address, included] of SOURCES) {
      await db.admin.query(
        "insert into public.newsletter_sources (user_id, sender_address, included) values ($1, $2, $3)",
        [id, address, included],
      );
    }
    const accessToken = `invented-access-${id.slice(0, 8)}`;
    const connectionId = await tokens.saveConnection(
      { userId: id, provider: "gmail", accountAddress: `reader-${id.slice(0, 8)}@inbox.example` },
      { accessToken, refreshToken: `invented-refresh-${id.slice(0, 8)}`, expiresAt: Date.now() + 3600_000, scope: READONLY },
    );
    return { id, connectionId, google: createFakeGoogle({ accessToken }) };
  }

  function run(
    user: TestUser,
    summarizer: SummaryProvider,
    extra: { limits?: Partial<PipelineLimits>; store?: PipelineStore; now?: Date } = {},
  ) {
    return runPipelineForUser(user.id, {
      store: extra.store ?? store,
      summarizer,
      now: () => extra.now ?? NOW,
      limits: extra.limits,
      adapterFor: (connection) =>
        gmailAdapterForConnection({
          connectionId: connection.id,
          store: tokens,
          oauth: {
            clientId: "invented-client-id",
            clientSecret: "invented-client-secret",
            redirectUri: "http://localhost:3000/api/mail/gmail/callback",
            fetch: user.google.fetch,
          },
          fetch: user.google.fetch,
        }),
    });
  }

  const rows = async (table: string, userId: string) =>
    (await db.admin.query(`select * from public.${table} where user_id = $1 order by 1`, [userId])).rows;
  const connectionRow = async (id: string) =>
    (await db.admin.query("select status, last_synced_at from public.mail_connections where id = $1", [id])).rows[0];
  /** Everything a user owns, for before/after comparisons. */
  const snapshot = async (userId: string) =>
    JSON.stringify(
      await Promise.all(
        ["user_settings", "newsletter_sources", "mail_connections", "newsletters", "summaries"].map((t) => rows(t, userId)),
      ),
    );

  beforeAll(async () => {
    db = await createTestDatabase();
    rpc = async (fn, args) => {
      const names = Object.keys(args);
      const params = names.map((n) => {
        const v = args[n];
        return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
      });
      const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")}) as result`;
      const r = await as(db.admin, { kind: "service" }, (q) => q(sql, params));
      return r.rows[0].result;
    };
    tokens = createVaultTokenStore(rpc);
    store = createRpcPipelineStore(rpc);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it("pulls, stores, adds new senders and summarizes at the user's chosen length", async () => {
    const a = await newUser({ length: "headline" });
    const summarizer = fakeSummarizer();
    const result = await run(a, summarizer);

    expect(result.connections).toEqual([
      expect.objectContaining({ connectionId: a.connectionId, outcome: "pulled", stored: 5, alreadyStored: 0, storeFailures: 0, newSenders: 3, capped: false }),
    ]);
    expect(result.summaries).toEqual({ created: 5, reused: 0, failed: 0, deferred: 0 });

    const newsletters = await rows("newsletters", a.id);
    expect(newsletters.map((n) => n.sender_address).sort()).toEqual(EXPECTED_SENDERS);
    for (const n of newsletters) expect(n.connection_id).toBe(a.connectionId);

    const sources = await rows("newsletter_sources", a.id);
    expect(sources.map((s) => [s.sender_address, s.included]).sort()).toEqual(
      [...SOURCES.map(([a, i]) => [a, i]), ["digest@quarry-ledger.example", true], ["lettre@cafe-lettre.example", true], ["news@brightline-weekly.example", true]].sort(),
    );

    const summaries = await rows("summaries", a.id);
    expect(summaries).toHaveLength(5);
    for (const s of summaries) expect(s.length).toBe("headline");
    expect(summarizer.calls.map((c) => c.length)).toEqual(Array(5).fill("headline"));

    const conn = await connectionRow(a.connectionId);
    expect(conn.status).toBe("active");
    expect(new Date(conn.last_synced_at).toISOString()).toBe(NOW.toISOString());
    // Every Gmail request was a read.
    expect(a.google.requests.every((r) => r.method === "GET" || r.url.startsWith("https://oauth2.googleapis.com/token"))).toBe(true);
  });

  it("the hidden-instruction newsletter reaches the summarizer and the database without its hidden text", async () => {
    const a = await newUser();
    const summarizer = fakeSummarizer();
    await run(a, summarizer);
    const harbor = summarizer.calls.find((c) => c.input.from.includes("editor@harbor-notes.example"));
    expect(harbor).toBeDefined();
    expect(harbor!.input.text).toContain("Tide tables for next week"); // the visible text is there
    for (const c of summarizer.calls) {
      expect(c.input.text).not.toMatch(HIDDEN);
      expect(c.input.subject).not.toMatch(HIDDEN);
      expect(c.input.text).not.toMatch(/https?:\/\//);
    }
    for (const n of await rows("newsletters", a.id)) expect(n.body_text).not.toMatch(HIDDEN);
  });

  it("is idempotent: re-running stores nothing twice and summarizes nothing twice", async () => {
    const a = await newUser();
    await run(a, fakeSummarizer());
    const before = await snapshot(a.id);

    // Same window again (as if last_synced_at had not moved): keyed on the message id.
    await db.admin.query("update public.mail_connections set last_synced_at = null where id = $1", [a.connectionId]);
    const again = fakeSummarizer();
    const result = await run(a, again);
    expect(result.connections[0]).toMatchObject({ outcome: "pulled", stored: 0, alreadyStored: 5, newSenders: 0 });
    expect(result.summaries).toEqual({ created: 0, reused: 0, failed: 0, deferred: 0 });
    expect(again.calls).toHaveLength(0);
    expect(await rows("newsletters", a.id)).toHaveLength(5);
    expect(await rows("summaries", a.id)).toHaveLength(5);

    // And a normal later run reads from last_synced_at, so nothing new either.
    const later = await run(a, fakeSummarizer(), { now: new Date(NOW.getTime() + 3600_000) });
    expect(later.connections[0]).toMatchObject({ outcome: "pulled", stored: 0 });
    const after = JSON.parse(await snapshot(a.id));
    const prior = JSON.parse(before);
    expect(after[3]).toEqual(prior[3]); // newsletters unchanged
    expect(after[4]).toEqual(prior[4]); // summaries unchanged
  });

  it("a summary that fails is counted, does not stop the others, and is retried on the next run", async () => {
    const a = await newUser();
    const summarizer = fakeSummarizer();
    summarizer.failSubjects.add("Two more evening ferries");
    const first = await run(a, summarizer);
    expect(first.summaries).toEqual({ created: 4, reused: 0, failed: 1, deferred: 0 });
    expect(await rows("summaries", a.id)).toHaveLength(4);

    const retry = fakeSummarizer();
    const second = await run(a, retry, { now: new Date(NOW.getTime() + 600_000) });
    expect(second.summaries).toEqual({ created: 1, reused: 0, failed: 0, deferred: 0 });
    expect(retry.calls.map((c) => c.input.subject)).toEqual(["Two more evening ferries"]);
    expect(await rows("summaries", a.id)).toHaveLength(5);
  });

  it("a newsletter that fails to store does not stop the others, and the window is not moved", async () => {
    const a = await newUser();
    const flaky: PipelineStore = {
      ...store,
      async saveNewsletter(userId, row) {
        if (row.senderAddress === "news@brightline-weekly.example") throw new Error("WriteFailed");
        return store.saveNewsletter(userId, row);
      },
    };
    const result = await run(a, fakeSummarizer(), { store: flaky });
    expect(result.connections[0]).toMatchObject({ outcome: "pulled", stored: 4, storeFailures: 1 });
    expect(await rows("newsletters", a.id)).toHaveLength(4);
    expect((await connectionRow(a.connectionId)).last_synced_at).toBeNull();
    // The next run picks the missing one up.
    const next = await run(a, fakeSummarizer());
    expect(next.connections[0]).toMatchObject({ stored: 1, alreadyStored: 4, storeFailures: 0 });
    expect(await rows("newsletters", a.id)).toHaveLength(5);
  });

  it("a revoked grant (MailAuthError) marks the connection 'error', stores nothing, and later runs skip it", async () => {
    const a = await newUser();
    const b = await newUser();
    a.google.alwaysUnauthorized = true;
    a.google.refreshRevoked = true;
    const bBefore = await snapshot(b.id);

    const result = await run(a, fakeSummarizer());
    expect(result.connections[0]).toMatchObject({ outcome: "auth_error", error: "mail_auth", stored: 0 });
    expect((await connectionRow(a.connectionId)).status).toBe("error");
    expect(await rows("newsletters", a.id)).toHaveLength(0);
    expect(await snapshot(b.id)).toBe(bBefore);

    const requests = a.google.requests.length;
    const again = await run(a, fakeSummarizer());
    expect(again.connections[0].outcome).toBe("skipped");
    expect(a.google.requests.length).toBe(requests);
  });

  it("other failures leave the connection active and the window unmoved", async () => {
    const a = await newUser();
    const broken = { ...a, google: { ...a.google, fetch: (async () => new Response("{}", { status: 500 })) as typeof fetch } };
    const result = await run(broken, fakeSummarizer());
    expect(result.connections[0]).toMatchObject({ outcome: "failed" });
    expect(await connectionRow(a.connectionId)).toEqual({ status: "active", last_synced_at: null });
  });

  it("cross-user isolation: the pipeline for A never writes B's rows, even with the same inbox", async () => {
    const a = await newUser();
    const b = await newUser();
    await run(b, fakeSummarizer());
    const bBefore = await snapshot(b.id);
    const counts = async () =>
      (await db.admin.query("select (select count(*) from public.newsletters) n, (select count(*) from public.summaries) s, (select count(*) from public.newsletter_sources) src")).rows[0];
    const before = await counts();

    const result = await run(a, fakeSummarizer());
    expect(result.connections.map((c) => c.connectionId)).toEqual([a.connectionId]);
    expect(await snapshot(b.id)).toBe(bBefore);
    const after = await counts();
    // Everything new belongs to A.
    expect(Number(after.n) - Number(before.n)).toBe((await rows("newsletters", a.id)).length);
    expect(Number(after.s) - Number(before.s)).toBe((await rows("summaries", a.id)).length);
    expect(Number(after.src) - Number(before.src)).toBe((await rows("newsletter_sources", a.id)).length - SOURCES.length);
    // Both stored the same provider message ids, each under their own connection.
    const ids = (u: string) => rows("newsletters", u).then((r) => r.map((n) => n.provider_message_id).sort());
    expect(await ids(a.id)).toEqual(await ids(b.id));
  });

  it("cross-user isolation in SQL: a user id cannot be paired with another user's rows", async () => {
    const a = await newUser();
    const b = await newUser();
    await run(b, fakeSummarizer());
    const bNewsletter = (await rows("newsletters", b.id))[0];
    const bBefore = await snapshot(b.id);

    await expect(
      store.saveNewsletter(a.id, {
        connectionId: b.connectionId,
        providerMessageId: "invented-new-id",
        senderAddress: "x@mail.example",
        subject: "s",
        receivedAt: NOW.toISOString(),
        bodyText: "t",
      }),
    ).rejects.toThrow();
    // Same message id as one B already has, on B's connection: no row is returned or written.
    await expect(
      store.saveNewsletter(a.id, {
        connectionId: b.connectionId,
        providerMessageId: bNewsletter.provider_message_id,
        senderAddress: "x@mail.example",
        subject: "s",
        receivedAt: NOW.toISOString(),
        bodyText: "t",
      }),
    ).rejects.toThrow();
    await expect(store.saveSummary(a.id, bNewsletter.id, "deep", "text")).rejects.toThrow();
    await expect(store.markConnection(a.id, b.connectionId, { status: "error" })).rejects.toThrow();
    expect(await store.pendingSummaries(a.id, "deep", new Date(0), 100)).toEqual([]);
    const loaded = await store.load(a.id);
    expect(loaded.connections.map((c) => c.id)).toEqual([a.connectionId]);
    expect(await snapshot(b.id)).toBe(bBefore);
  });

  it("is bounded: messages listed, characters per newsletter, summaries and characters per run", async () => {
    const a = await newUser();
    const small = await run(a, fakeSummarizer(), { limits: { maxMessagesPerConnection: 3 } });
    expect(small.connections[0]).toMatchObject({ listed: 3, capped: true });
    expect(a.google.requests.filter((r) => /\/messages\/\w+\?/.test(r.url))).toHaveLength(3);

    const b = await newUser();
    const summarizer = fakeSummarizer();
    const capped = await run(b, summarizer, { limits: { maxSummariesPerRun: 2, maxCharsPerNewsletter: 120 } });
    expect(capped.summaries.created).toBe(2);
    expect(capped.summaries.deferred).toBeGreaterThanOrEqual(1);
    expect(summarizer.calls).toHaveLength(2);
    for (const n of await rows("newsletters", b.id)) expect(n.body_text.length).toBeLessThanOrEqual(120);
    for (const c of summarizer.calls) expect(c.input.text.length).toBeLessThanOrEqual(120);

    const c = await newUser();
    const budget = fakeSummarizer();
    const byChars = await run(c, budget, { limits: { maxSummaryCharsPerRun: 1 } });
    expect(byChars.summaries).toMatchObject({ created: 0, failed: 0 });
    expect(byChars.summaries.deferred).toBeGreaterThan(0);
    expect(budget.calls).toHaveLength(0);
  });

  it("results hold counts and codes only, never newsletter text, addresses or tokens", async () => {
    const a = await newUser();
    a.google.alwaysUnauthorized = true;
    a.google.refreshRevoked = true;
    const failed = JSON.stringify(await run(a, fakeSummarizer()));
    const b = await newUser();
    const ok = JSON.stringify(await run(b, fakeSummarizer()));
    for (const s of [failed, ok]) {
      expect(s).not.toMatch(/@|invented-|ferry|Harbor|https?:/i);
    }
  });

  it("the pipeline functions are server-only: anon and signed-in users cannot call them", async () => {
    const a = await newUser();
    const calls = [
      ["pipeline_load($1::uuid)", [a.id]],
      ["pipeline_add_sources($1::uuid, '[]'::jsonb)", [a.id]],
      ["pipeline_pending_summaries($1::uuid, 'brief', now(), 10)", [a.id]],
      ["pipeline_mark_connection($1::uuid, $2::uuid, 'error', null)", [a.id, a.connectionId]],
      ["pipeline_save_summary($1::uuid, $1::uuid, 'brief', 'x')", [a.id]],
      ["pipeline_save_newsletter($1::uuid, $2::uuid, 'm', 'x@mail.example', null, 's', now(), 't')", [a.id, a.connectionId]],
    ] as const;
    for (const [call, params] of calls) {
      for (const actor of [{ kind: "anon" }, { kind: "user", id: a.id }] as const) {
        const r = await attempt(db.admin, actor, `select public.${call}`, [...params]);
        expect(r.error?.code, `${actor.kind} ${call}`).toBe("42501");
      }
    }
    expect((await connectionRow(a.connectionId)).status).toBe("active");
  });
});
