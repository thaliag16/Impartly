// Summary cost on a real Postgres (supabase/migrations/20261124210000_summary_cost.sql plus
// lib/pipeline): the usage table (server-written, owner-read), never summarizing an issue
// that will not be played (switched-off feed, stored before the briefing's window), never
// paying twice for the same text (copied within a run and across runs), and the usage of
// every model call recorded, failed ones included. Invented data only; no model is called.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Rpc } from "../../lib/mail";
import { createRpcPipelineStore, runPipelineForUser, type PipelineSchedule, type PipelineStore } from "../../lib/pipeline";
import type { NewsletterSource, SourceItem } from "../../lib/sources/types";
import type { Newsletter, SummaryLength, SummaryProvider, SummaryUsage } from "../../lib/summarizer/types";
import { as, attempt, createTestDatabase, databaseUrl, type TestDatabase } from "./harness";

const NOW = new Date("2026-11-24T06:45:00.000Z");
const DELIVERY = new Date("2026-11-24T07:00:00.000Z");

interface Fake extends SummaryProvider {
  calls: { input: Newsletter; length: SummaryLength }[];
}
/** Reports usage like the real provider (once per summary, even when it fails). */
function fakeSummarizer(opts: { failSubjects?: string[]; cost?: number } = {}): Fake {
  const f: Fake = {
    calls: [],
    async summarize(input, { length, onUsage }) {
      f.calls.push({ input, length });
      const usage: SummaryUsage = {
        model: "invented-model",
        requests: 1,
        thinking: false,
        promptTokens: 400,
        completionTokens: 60,
        reasoningTokens: 0,
        ...(opts.cost === undefined ? {} : { cost: opts.cost }),
      };
      onUsage?.(usage);
      if (opts.failSubjects?.includes(input.subject)) throw new Error("SummaryError");
      return `A ${length} summary of ${input.subject}.`;
    },
  };
  return f;
}

const item = (key: string, subject: string, bodyText: string, receivedAt = "2026-11-24T05:00:00.000Z"): SourceItem => ({
  key,
  senderAddress: "invented.example",
  senderName: "Invented Feed",
  subject,
  receivedAt,
  bodyText,
  truncated: false,
  partial: false,
});

describe.skipIf(!databaseUrl)("summary cost on real Postgres", () => {
  let db: TestDatabase;
  let rpc: Rpc;
  let store: PipelineStore;
  const q = (sql: string, params?: unknown[]) => db.admin.query(sql, params);

  const newUser = async () => {
    const id = randomUUID();
    await q("insert into auth.users (id) values ($1)", [id]);
    return id;
  };
  const addFeed = async (userId: string, included = true) =>
    (
      await q(
        "insert into public.web_feeds (user_id, feed_url, feed_format, title, included) values ($1, $2, 'rss', 'Invented feed', $3) returning id",
        [userId, `https://feeds.example/${randomUUID()}.xml`, included],
      )
    ).rows[0].id as string;
  const addIssue = async (userId: string, feedId: string, body: string, opts: { createdAt?: string; subject?: string } = {}) =>
    (
      await q(
        `insert into public.newsletters (user_id, feed_id, provider_message_id, sender_address, subject, received_at, body_text, created_at)
         values ($1, $2, $3, 'invented.example', $4, '2026-11-24T05:00:00Z', $5, coalesce($6::timestamptz, now())) returning id`,
        [userId, feedId, randomUUID(), opts.subject ?? "Invented issue", body, opts.createdAt ?? null],
      )
    ).rows[0].id as string;
  const summaries = async (userId: string) =>
    (await q("select newsletter_id, length, summary_text from public.summaries where user_id = $1 order by summary_text", [userId])).rows;
  const usage = async (userId: string) =>
    (await q("select * from public.summary_usage where user_id = $1 order by created_at", [userId])).rows;

  /** Feeds whose pulls return the given items (no network). */
  const run = (userId: string, items: Record<string, SourceItem[]>, summarizer: SummaryProvider, schedule?: PipelineSchedule) =>
    runPipelineForUser(userId, {
      store,
      summarizer,
      now: () => NOW,
      schedule,
      sourceFor: (stored) => {
        const id = stored.kind === "web" ? stored.feed.id : stored.connection.id;
        const source: NewsletterSource = {
          kind: "web",
          id,
          async pull() {
            const list = items[id] ?? [];
            return { items: list, listed: list.length, capped: false };
          },
        };
        return source;
      },
    });
  const scheduled = (playableSince: Date): PipelineSchedule => ({
    cycleStart: new Date(NOW.getTime() - 60_000),
    canStart: () => true,
    deliveryAt: DELIVERY,
    playableSince,
  });

  beforeAll(async () => {
    db = await createTestDatabase();
    rpc = async (fn, args) => {
      const names = Object.keys(args);
      const params = names.map((n) => {
        const v = args[n];
        return v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v;
      });
      const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")}) as result`;
      const r = await as(db.admin, { kind: "service" }, (qq) => qq(sql, params));
      return r.rows[0].result;
    };
    store = createRpcPipelineStore(rpc);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it("summarizes identical text once per run, stores it for every copy, and records the one model call", async () => {
    const a = await newUser();
    const [f1, f2] = [await addFeed(a), await addFeed(a)];
    const same = "Larkspur raised $40 million.\n\nThe round was led by Juniper Peak.";
    const fake = fakeSummarizer({ cost: 0.00012 });
    const result = await run(
      a,
      {
        [f1]: [item("a1", "Larkspur raises", same), item("a2", "Quillmarsh earnings", "Quillmarsh earned $4.5 billion.")],
        // The same issue syndicated to a second feed, white space and case aside.
        [f2]: [item("b1", "Larkspur raises (syndicated)", `  ${same.toUpperCase().replace("\n\n", "\n \n")}  `)],
      },
      fake,
      scheduled(new Date(DELIVERY.getTime() - 30 * 60_000)),
    );
    expect(fake.calls).toHaveLength(2);
    expect(result.summaries).toEqual({ created: 2, reused: 1, failed: 0, deferred: 0 });
    const rows = await summaries(a);
    expect(rows).toHaveLength(3);
    const rec = await usage(a);
    expect(rec).toHaveLength(2);
    expect(rec.map((r) => [r.model, r.requests, r.prompt_units, r.completion_units, r.reasoning_units, r.thinking, Number(r.cost_usd), r.length])).toEqual([
      ["invented-model", 1, 400, 60, 0, false, 0.00012, "brief"],
      ["invented-model", 1, 400, 60, 0, false, 0.00012, "brief"],
    ]);
    for (const r of rec) {
      expect(new Date(r.delivery_at).toISOString()).toBe(DELIVERY.toISOString());
      expect(r.newsletter_id).toBeTruthy();
    }
  });

  it("copies a summary to an identical issue stored in a later run, with no model call", async () => {
    const a = await newUser();
    const f1 = await addFeed(a);
    const first = await addIssue(a, f1, "Ridgeback FC won the Coastal Cup 3-1.");
    await q("insert into public.summaries (user_id, newsletter_id, length, summary_text) values ($1, $2, 'brief', 'Ridgeback won 3-1.')", [a, first]);
    const f2 = await addFeed(a);
    const fake = fakeSummarizer();
    const result = await run(a, { [f2]: [item("c1", "Cup final", "ridgeback fc   won the coastal cup 3-1.")] }, fake);
    expect(fake.calls).toHaveLength(0);
    expect(result.summaries).toEqual({ created: 0, reused: 1, failed: 0, deferred: 0 });
    expect((await summaries(a)).map((r) => r.summary_text)).toEqual(["Ridgeback won 3-1.", "Ridgeback won 3-1."]);
    expect(await usage(a)).toEqual([]);
  });

  it("reuse is exact text, same length, same user, last 7 days only", async () => {
    const [a, b] = [await newUser(), await newUser()];
    const fa = await addFeed(a);
    const fb = await addFeed(b);
    const old = await addIssue(a, fa, "Old text.");
    await q(
      "insert into public.summaries (user_id, newsletter_id, length, summary_text, created_at) values ($1, $2, 'brief', 'Old.', now() - interval '8 days')",
      [a, old],
    );
    const deep = await addIssue(a, fa, "Deep only.");
    await q("insert into public.summaries (user_id, newsletter_id, length, summary_text) values ($1, $2, 'deep', 'Deep.')", [a, deep]);
    const other = await addIssue(b, fb, "Other user text.");
    await q("insert into public.summaries (user_id, newsletter_id, length, summary_text) values ($1, $2, 'brief', 'Theirs.')", [b, other]);
    for (const body of ["Old text.", "Deep only.", "Other user text.", "Old text, edited."]) await addIssue(a, fa, body);
    const copied = await rpc("pipeline_reuse_summaries", {
      p_user_id: a,
      p_length: "brief",
      p_since: "2026-11-20T00:00:00Z",
      p_stored_since: null,
    });
    expect(copied).toBe(0);
    expect((await summaries(b)).map((r) => r.summary_text)).toEqual(["Theirs."]);
  });

  it("never asks for a summary of a switched-off feed's issue", async () => {
    const a = await newUser();
    const on = await addFeed(a);
    const off = await addFeed(a, false);
    await addIssue(a, on, "On feed text.", { subject: "On" });
    await addIssue(a, off, "Off feed text.", { subject: "Off" });
    const pending = await store.pendingSummaries(a, "brief", new Date("2026-11-20T00:00:00Z"), 10);
    expect(pending.map((p) => p.subject)).toEqual(["On"]);
    const fake = fakeSummarizer();
    await run(a, {}, fake);
    expect(fake.calls.map((c) => c.input.subject)).toEqual(["On"]);
  });

  it("a scheduled pull skips issues stored before the briefing's window (no briefing would play them)", async () => {
    const a = await newUser();
    const f = await addFeed(a);
    await addIssue(a, f, "Stored yesterday, never summarized.", { subject: "Yesterday", createdAt: "2026-11-23T06:40:00Z" });
    await addIssue(a, f, "Stored for this briefing.", { subject: "Today", createdAt: "2026-11-24T06:35:00Z" });
    const fake = fakeSummarizer();
    const playableSince = new Date(DELIVERY.getTime() - 30 * 60_000);
    await run(a, {}, fake, scheduled(playableSince));
    expect(fake.calls.map((c) => c.input.subject)).toEqual(["Today"]);
    const pending = await store.pendingSummaries(a, "brief", new Date("2026-11-20T00:00:00Z"), 10, playableSince);
    expect(pending).toEqual([]);
    // A run outside the schedule (no window) still catches up on it.
    const manual = fakeSummarizer();
    await run(a, {}, manual);
    expect(manual.calls.map((c) => c.input.subject)).toEqual(["Yesterday"]);
  });

  it("records the usage of a failed summary too (it was paid for), and a usage write failure never loses the summary", async () => {
    const a = await newUser();
    const f = await addFeed(a);
    const fake = fakeSummarizer({ failSubjects: ["Breaks"], cost: 0.0002 });
    const result = await run(a, { [f]: [item("d1", "Breaks", "Text one."), item("d2", "Works", "Text two.")] }, fake);
    expect(result.summaries).toMatchObject({ created: 1, failed: 1 });
    expect((await usage(a)).map((r) => Number(r.cost_usd))).toEqual([0.0002, 0.0002]);

    const b = await newUser();
    const fb = await addFeed(b);
    const broken: PipelineStore = { ...store, recordUsage: async () => Promise.reject(new Error("down")) };
    const r2 = await runPipelineForUser(b, {
      store: broken,
      summarizer: fakeSummarizer(),
      now: () => NOW,
      sourceFor: () => ({ kind: "web", id: fb, pull: async () => ({ items: [item("e1", "Kept", "Kept text.")], listed: 1, capped: false }) }),
    });
    expect(r2.summaries).toMatchObject({ created: 1, failed: 0 });
  });

  it("keeps the cost when the issue is deleted; only the server writes usage; each user reads only their own", async () => {
    const [a, b] = [await newUser(), await newUser()];
    const f = await addFeed(a);
    const n = await addIssue(a, f, "To be removed.");
    const args: unknown[] = [a, n, DELIVERY.toISOString(), "brief", "invented-model", 1, 300, 50, 0, false, 0.0001];
    const call =
      "select public.pipeline_record_usage($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)";
    for (const actor of [{ kind: "anon" } as const, { kind: "user", id: a } as const]) {
      expect((await attempt(db.admin, actor, call, args)).error?.code).toBe("42501");
      expect(
        (await attempt(db.admin, actor, "insert into public.summary_usage (user_id, length, model, requests, prompt_units, completion_units, reasoning_units, thinking) values ($1, 'brief', 'm', 1, 1, 1, 0, false)", [a])).error?.code,
      ).toBe("42501");
    }
    await as(db.admin, { kind: "service" }, (qq) => qq(call, args));
    // Another user's issue cannot be named.
    const fb = await addFeed(b);
    const theirs = await addIssue(b, fb, "Theirs.");
    expect((await attempt(db.admin, { kind: "service" }, call, [a, theirs, ...args.slice(2)])).error?.code).toBe("23503");
    // Bad values are refused.
    for (const [i, v] of [[5, 0], [6, -1], [8, -5], [10, -0.1], [10, "NaN"], [4, ""]] as [number, unknown][]) {
      const bad = [...args];
      bad[i] = v;
      expect((await attempt(db.admin, { kind: "service" }, call, bad)).error, `arg ${i} = ${String(v)}`).toBeTruthy();
    }

    const read = async (who: string) =>
      (await as(db.admin, { kind: "user", id: who }, (qq) => qq("select user_id, newsletter_id, cost_usd from public.summary_usage"))).rows;
    expect(await read(a)).toHaveLength(1);
    expect(await read(b)).toEqual([]);

    await q("delete from public.newsletters where id = $1", [n]);
    const kept = await usage(a);
    expect(kept).toHaveLength(1);
    expect(kept[0].newsletter_id).toBeNull();
    expect(Number(kept[0].cost_usd)).toBe(0.0001);
  });
});
