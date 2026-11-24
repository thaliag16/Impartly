// Row-level security tests for supabase/migrations (GOAL.md Phase 1: "Every table has RLS,
// verified by a test that a second user cannot read the first user's rows").
//
// Runs against a real Postgres (see tests/db/harness.ts). The API roles behave as on
// Supabase: anon and authenticated go through RLS, service_role bypasses it.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  as,
  assertLocalDatabaseUrl,
  attempt,
  createTestDatabase,
  databaseUrl,
  dbRequired,
  migrationFiles,
  type TestDatabase,
} from "./harness";

const RLS_VIOLATION_OR_NO_PRIVILEGE = "42501";

describe("db harness safety", () => {
  it("refuses any DATABASE_URL that is not a local server", () => {
    expect(() => assertLocalDatabaseUrl("postgres://u:p@db.example.supabase.co:5432/postgres")).toThrow(
      /not local/,
    );
    expect(() => assertLocalDatabaseUrl("postgres://u:p@10.0.0.5/postgres")).toThrow(/not local/);
    expect(() => assertLocalDatabaseUrl("mysql://localhost/x")).toThrow(/postgres/);
    expect(assertLocalDatabaseUrl("postgres://postgres:postgres@localhost:5432/postgres").hostname).toBe(
      "localhost",
    );
    expect(assertLocalDatabaseUrl("postgresql://postgres@127.0.0.1:54329/postgres").port).toBe("54329");
  });

  it("migrations follow the Supabase CLI naming (<timestamp>_<name>.sql)", () => {
    const files = migrationFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(f).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
  });
});

if (!databaseUrl && dbRequired) {
  describe("database tests", () => {
    it("need DATABASE_URL (a local Postgres superuser URL)", () => {
      throw new Error(
        "DATABASE_URL is not set, and CI=true or REQUIRE_DB=1 says the database tests must run.",
      );
    });
  });
}

if (!databaseUrl && !dbRequired) {
  console.warn(
    "[db] DATABASE_URL not set: skipping the RLS tests. Point it at a throwaway local " +
      "Postgres superuser to run them (see the Contributing section of README.md).",
  );
}

// Every table in public. A new table must be added here, with its access rules, or the
// "exact table list" test fails: no table can slip in without cross-user tests.
type Access = "own-rw" | "own-read";
interface TableSpec {
  name: string;
  access: Access;
  /** Primary key column used to address a row. */
  key: string;
  /** Columns an authenticated user may read (select * is not allowed where columns are hidden). */
  readCols: string;
  /** A column and a new value for update attempts. */
  update: [string, unknown];
}

const TABLES: TableSpec[] = [
  {
    name: "user_settings",
    access: "own-rw",
    key: "user_id",
    readCols: "user_id, delivery_time, timezone, summary_length, voice, speed, feed_order",
    update: ["summary_length", "deep"],
  },
  {
    name: "newsletter_sources",
    access: "own-rw",
    key: "id",
    readCols: "id, user_id, sender_address, display_name, included",
    update: ["included", false],
  },
  {
    name: "mail_connections",
    access: "own-read",
    key: "id",
    readCols: "id, user_id, provider, account_address, status, created_at, last_synced_at",
    update: ["status", "revoked"],
  },
  {
    name: "web_feeds",
    access: "own-read",
    key: "id",
    readCols: "id, user_id, feed_url, feed_format, title, homepage_url, catalog_id, included, last_fetched_at, last_error",
    update: ["included", false],
  },
  {
    name: "newsletters",
    access: "own-read",
    key: "id",
    readCols: "id, user_id, connection_id, sender_address, subject, received_at, body_text",
    update: ["subject", "changed"],
  },
  {
    name: "summaries",
    access: "own-read",
    key: "id",
    readCols: "id, user_id, newsletter_id, length, summary_text, created_at",
    update: ["summary_text", "changed"],
  },
];

describe.skipIf(!databaseUrl)("supabase migrations: row-level security", () => {
  let db: TestDatabase;
  const A = randomUUID();
  const B = randomUUID();
  // Primary keys of each user's row, per table.
  const rows: Record<string, { A: string; B: string }> = {};
  // Insert statements a user could try, per table, keyed by owner.
  let insertFor: Record<string, (owner: string) => [string, unknown[]]>;

  beforeAll(async () => {
    db = await createTestDatabase();
    const q = (sql: string, p?: unknown[]) => db.admin.query(sql, p);
    const ids: Record<string, Record<string, string>> = {};

    for (const [label, id] of [["A", A], ["B", B]] as const) {
      await q("insert into auth.users (id, email) values ($1, $2)", [id, `${label.toLowerCase()}@test.example`]);
      ids[label] = {};
      await q(
        "insert into public.user_settings (user_id, delivery_time, timezone) values ($1, '06:30', 'America/Los_Angeles')",
        [id],
      );
      ids[label].user_settings = id;
      ids[label].newsletter_sources = (
        await q(
          "insert into public.newsletter_sources (user_id, sender_address, display_name) values ($1, $2, 'Invented Weekly') returning id",
          [id, `news-${label.toLowerCase()}@weekly.example`],
        )
      ).rows[0].id;
      ids[label].mail_connections = (
        await q(
          "insert into public.mail_connections (user_id, provider, account_address, token_secret_id) values ($1, 'gmail', $2, $3) returning id",
          [id, `${label}@mail.example`, randomUUID()],
        )
      ).rows[0].id;
      ids[label].web_feeds = (
        await q(
          "insert into public.web_feeds (user_id, feed_url, feed_format, title) values ($1, $2, 'rss', 'Invented Feed') returning id",
          [id, `https://feeds-${label.toLowerCase()}.example/feed`],
        )
      ).rows[0].id;
      ids[label].newsletters = (
        await q(
          "insert into public.newsletters (user_id, connection_id, provider_message_id, sender_address, subject, received_at, body_text) values ($1, $2, $3, 'news@weekly.example', 'Invented issue', now(), 'Invented body.') returning id",
          [id, ids[label].mail_connections, `msg-${label}`],
        )
      ).rows[0].id;
      ids[label].summaries = (
        await q(
          "insert into public.summaries (user_id, newsletter_id, length, summary_text) values ($1, $2, 'brief', 'An invented summary.') returning id",
          [id, ids[label].newsletters],
        )
      ).rows[0].id;
    }
    for (const t of TABLES) rows[t.name] = { A: ids.A[t.name], B: ids.B[t.name] };

    insertFor = {
      user_settings: (owner) => ["insert into public.user_settings (user_id) values ($1)", [owner]],
      newsletter_sources: (owner) => [
        "insert into public.newsletter_sources (user_id, sender_address) values ($1, $2)",
        [owner, `new-${randomUUID()}@weekly.example`],
      ],
      mail_connections: (owner) => [
        "insert into public.mail_connections (user_id, provider, account_address, token_secret_id) values ($1, 'gmail', 'x@mail.example', $2)",
        [owner, randomUUID()],
      ],
      web_feeds: (owner) => [
        "insert into public.web_feeds (user_id, feed_url, feed_format, title) values ($1, $2, 'atom', 'Another Invented Feed')",
        [owner, `https://feeds.example/${randomUUID()}.xml`],
      ],
      newsletters: (owner) => [
        "insert into public.newsletters (user_id, connection_id, provider_message_id, sender_address, subject, received_at, body_text) values ($1, $2, $3, 'n@weekly.example', 's', now(), 'b')",
        [owner, owner === A ? ids.A.mail_connections : ids.B.mail_connections, randomUUID()],
      ],
      summaries: (owner) => [
        "insert into public.summaries (user_id, newsletter_id, length, summary_text) values ($1, $2, 'headline', 'x')",
        [owner, owner === A ? ids.A.newsletters : ids.B.newsletters],
      ],
    };
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  // ---- Schema-wide guards -------------------------------------------------------------

  const tablesWithoutRls = async () =>
    (
      await db.admin.query(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname in ('public', 'private') and c.relkind in ('r', 'p') and not c.relrowsecurity
         order by 1`,
      )
    ).rows.map((r) => r.relname as string);

  it("every table in public and private has row-level security enabled", async () => {
    expect(await tablesWithoutRls()).toEqual([]);
  });

  it("the RLS check catches a table without RLS (control)", async () => {
    await db.admin.query("begin");
    try {
      await db.admin.query("create table public.control_no_rls (id int)");
      expect(await tablesWithoutRls()).toEqual(["control_no_rls"]);
    } finally {
      await db.admin.query("rollback");
    }
  });

  it("public holds exactly the tables these tests cover", async () => {
    const r = await db.admin.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f') order by 1`,
    );
    expect(r.rows.map((x) => x.relname)).toEqual(TABLES.map((t) => t.name).sort());
  });

  it("anon has no privilege on any table in public", async () => {
    const r = await db.admin.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
         and (has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
              or has_any_column_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES'))`,
    );
    expect(r.rows).toEqual([]);
  });

  it("no plain token or secret columns: only a uuid reference into Supabase Vault", async () => {
    const r = await db.admin.query(
      `select table_name, column_name, data_type from information_schema.columns
       where table_schema = 'public'
         and column_name ~* '(token|secret|password|credential|api_?key|refresh|access_?key)'`,
    );
    for (const col of r.rows) {
      expect(`${col.table_name}.${col.column_name}`).toMatch(/\.[a-z_]+_secret_id$/);
      expect(col.data_type).toBe("uuid");
    }
    expect(r.rows.map((c) => `${c.table_name}.${c.column_name}`)).toEqual([
      "mail_connections.token_secret_id",
    ]);
  });

  it("signed-in users cannot read the Vault reference column", async () => {
    const r = await attempt(db.admin, { kind: "user", id: A }, "select token_secret_id from public.mail_connections");
    expect(r.error?.code).toBe(RLS_VIOLATION_OR_NO_PRIVILEGE);
    const svc = await attempt(db.admin, { kind: "service" }, "select token_secret_id from public.mail_connections");
    expect(svc.error).toBeNull();
    expect(svc.rowCount).toBe(2);
  });

  // ---- Per-table cross-user tests -----------------------------------------------------

  describe.each(TABLES)("$name", (t) => {
    const table = `public.${t.name}`;

    it("anon sees nothing and can write nothing", async () => {
      const sel = await attempt(db.admin, { kind: "anon" }, `select ${t.readCols} from ${table}`);
      expect(sel.error?.code ?? "no error").toBe(RLS_VIOLATION_OR_NO_PRIVILEGE);
      const [isql, iparams] = insertFor[t.name](A);
      expect((await attempt(db.admin, { kind: "anon" }, isql, iparams)).error?.code).toBe(
        RLS_VIOLATION_OR_NO_PRIVILEGE,
      );
      const upd = await attempt(db.admin, { kind: "anon" }, `update ${table} set ${t.update[0]} = $1`, [t.update[1]]);
      expect(upd.error?.code).toBe(RLS_VIOLATION_OR_NO_PRIVILEGE);
      const del = await attempt(db.admin, { kind: "anon" }, `delete from ${table}`);
      expect(del.error?.code).toBe(RLS_VIOLATION_OR_NO_PRIVILEGE);
    });

    it("user A reads only their own rows", async () => {
      const r = await attempt(db.admin, { kind: "user", id: A }, `select ${t.readCols} from ${table}`);
      expect(r.error).toBeNull();
      expect(r.rowCount).toBe(1);
      expect((r.rows[0] as { user_id: string }).user_id).toBe(A);
    });

    it("user B cannot select user A's row", async () => {
      const r = await attempt(
        db.admin,
        { kind: "user", id: B },
        `select ${t.readCols} from ${table} where ${t.key} = $1`,
        [rows[t.name].A],
      );
      expect(r.error).toBeNull();
      expect(r.rowCount).toBe(0);
    });

    it("user B cannot insert a row owned by user A", async () => {
      const [sql, params] = insertFor[t.name](A);
      const r = await attempt(db.admin, { kind: "user", id: B }, sql, params);
      expect(r.error?.code).toBe(RLS_VIOLATION_OR_NO_PRIVILEGE);
    });

    it("user B cannot update user A's row", async () => {
      const before = (await db.admin.query(`select * from ${table} where ${t.key} = $1`, [rows[t.name].A])).rows[0];
      const r = await attempt(
        db.admin,
        { kind: "user", id: B },
        `update ${table} set ${t.update[0]} = $1 where ${t.key} = $2`,
        [t.update[1], rows[t.name].A],
      );
      // Either refused outright (no update privilege) or filtered to zero rows by RLS.
      if (r.error) expect(r.error.code).toBe(RLS_VIOLATION_OR_NO_PRIVILEGE);
      else expect(r.rowCount).toBe(0);
      const after = (await db.admin.query(`select * from ${table} where ${t.key} = $1`, [rows[t.name].A])).rows[0];
      expect(after).toEqual(before);
    });

    it("user B cannot move their own row to user A", async () => {
      const r = await attempt(
        db.admin,
        { kind: "user", id: B },
        `update ${table} set user_id = $1 where ${t.key} = $2`,
        [A, rows[t.name].B],
      );
      expect(r.error?.code).toBe(RLS_VIOLATION_OR_NO_PRIVILEGE);
    });

    it("user B cannot delete user A's row", async () => {
      const r = await attempt(db.admin, { kind: "user", id: B }, `delete from ${table} where ${t.key} = $1`, [
        rows[t.name].A,
      ]);
      if (r.error) expect(r.error.code).toBe(RLS_VIOLATION_OR_NO_PRIVILEGE);
      else expect(r.rowCount).toBe(0);
      const still = await db.admin.query(`select 1 from ${table} where ${t.key} = $1`, [rows[t.name].A]);
      expect(still.rowCount).toBe(1);
    });

    if (t.access === "own-rw") {
      it("user A can update and delete their own row (so the denials above are RLS, not a broken table)", async () => {
        await as(db.admin, { kind: "user", id: A }, async (q) => {
          const u = await q(`update ${table} set ${t.update[0]} = $1 where ${t.key} = $2`, [
            t.update[1],
            rows[t.name].A,
          ]);
          expect(u.rowCount).toBe(1);
          const d = await q(`delete from ${table} where ${t.key} = $1`, [rows[t.name].A]);
          expect(d.rowCount).toBe(1);
          throw new Error("rollback");
        }).catch((e: Error) => {
          if (e.message !== "rollback") throw e;
        });
      });

      it("user A can insert a row for themselves", async () => {
        const [sql, params] = insertFor[t.name](A);
        // user_settings has one row per user, so insert after removing it, then roll back.
        await as(db.admin, { kind: "user", id: A }, async (q) => {
          if (t.name === "user_settings") await q("delete from public.user_settings where user_id = $1", [A]);
          const r = await q(sql, params);
          expect(r.rowCount).toBe(1);
          throw new Error("rollback");
        }).catch((e: Error) => {
          if (e.message !== "rollback") throw e;
        });
      });
    } else {
      it("is written by the server only: user A cannot insert, update or delete even their own rows", async () => {
        const [sql, params] = insertFor[t.name](A);
        expect((await attempt(db.admin, { kind: "user", id: A }, sql, params)).error?.code).toBe(
          RLS_VIOLATION_OR_NO_PRIVILEGE,
        );
        const u = await attempt(
          db.admin,
          { kind: "user", id: A },
          `update ${table} set ${t.update[0]} = $1 where ${t.key} = $2`,
          [t.update[1], rows[t.name].A],
        );
        expect(u.error?.code).toBe(RLS_VIOLATION_OR_NO_PRIVILEGE);
        const d = await attempt(db.admin, { kind: "user", id: A }, `delete from ${table} where ${t.key} = $1`, [
          rows[t.name].A,
        ]);
        expect(d.error?.code).toBe(RLS_VIOLATION_OR_NO_PRIVILEGE);
      });

      it("the service role (server pipeline) can write it", async () => {
        const [sql, params] = insertFor[t.name](A);
        await as(db.admin, { kind: "service" }, async (q) => {
          expect((await q(sql, params)).rowCount).toBe(1);
          throw new Error("rollback");
        }).catch((e: Error) => {
          if (e.message !== "rollback") throw e;
        });
      });
    }
  });

  // ---- Integrity and validation ---------------------------------------------------------

  it("a newsletter cannot point at another user's mail connection, even from the server", async () => {
    const r = await attempt(
      db.admin,
      { kind: "service" },
      "insert into public.newsletters (user_id, connection_id, provider_message_id, sender_address, subject, received_at, body_text) values ($1, $2, 'cross', 'n@weekly.example', 's', now(), 'b')",
      [B, rows.mail_connections.A],
    );
    expect(r.error?.code).toBe("23503");
  });

  it("a newsletter cannot point at another user's web feed, even from the server", async () => {
    const r = await attempt(
      db.admin,
      { kind: "service" },
      "insert into public.newsletters (user_id, feed_id, provider_message_id, sender_address, subject, received_at, body_text) values ($1, $2, 'cross', 'feeds.example', 's', now(), 'b')",
      [B, rows.web_feeds.A],
    );
    expect(r.error?.code).toBe("23503");
  });

  it("a newsletter comes from exactly one source: a mail connection or a web feed", async () => {
    const both = await attempt(
      db.admin,
      { kind: "service" },
      "insert into public.newsletters (user_id, connection_id, feed_id, provider_message_id, sender_address, subject, received_at, body_text) values ($1, $2, $3, 'both', 'feeds.example', 's', now(), 'b')",
      [A, rows.mail_connections.A, rows.web_feeds.A],
    );
    expect(both.error?.code).toBe("23514");
    const neither = await attempt(
      db.admin,
      { kind: "service" },
      "insert into public.newsletters (user_id, provider_message_id, sender_address, subject, received_at, body_text) values ($1, 'neither', 'feeds.example', 's', now(), 'b')",
      [A],
    );
    expect(neither.error?.code).toBe("23514");
  });

  it.each([
    ["a non-http feed URL", "feed_url", "file:///etc/passwd"],
    ["an unknown feed format", "feed_format", "json"],
    ["a free-text last_error", "last_error", "Error: something with a URL https://x.example"],
  ])("web feeds reject %s, even from the server", async (_label, col, value) => {
    const r = await attempt(db.admin, { kind: "service" }, `update public.web_feeds set ${col} = $1 where id = $2`, [
      value,
      rows.web_feeds.A,
    ]);
    expect(r.error?.code).toBe("23514");
  });

  it("a summary cannot point at another user's newsletter, even from the server", async () => {
    const r = await attempt(
      db.admin,
      { kind: "service" },
      "insert into public.summaries (user_id, newsletter_id, length, summary_text) values ($1, $2, 'deep', 'x')",
      [B, rows.newsletters.A],
    );
    expect(r.error?.code).toBe("23503");
  });

  it.each([
    ["timezone", "Not/AZone"],
    ["summary_length", "novel"],
    ["voice", "unknown_voice"],
    ["speed", 3],
    ["speed", 0.1],
  ])("user settings reject an invalid %s (%s)", async (col, value) => {
    const r = await attempt(db.admin, { kind: "user", id: A }, `update public.user_settings set ${col} = $1`, [value]);
    expect(r.error?.code).toBe("23514");
  });

  it("new user settings get the documented defaults", async () => {
    await as(db.admin, { kind: "user", id: A }, async (q) => {
      await q("delete from public.user_settings where user_id = $1", [A]);
      const r = await q(
        "insert into public.user_settings (user_id) values ($1) returning delivery_time, timezone, summary_length, voice, speed",
        [A],
      );
      expect(r.rows[0]).toEqual({
        delivery_time: "07:00:00",
        timezone: "UTC",
        summary_length: "brief",
        voice: "af_heart",
        speed: "1.00",
      });
      throw new Error("rollback");
    }).catch((e: Error) => {
      if (e.message !== "rollback") throw e;
    });
  });

  it("deleting an auth user deletes all of their rows", async () => {
    await db.admin.query("begin");
    try {
      await db.admin.query("delete from auth.users where id = $1", [A]);
      for (const t of TABLES) {
        const r = await db.admin.query(`select count(*)::int as n from public.${t.name} where user_id = $1`, [A]);
        expect(r.rows[0].n).toBe(0);
      }
      const rest = await db.admin.query("select count(*)::int as n from public.summaries where user_id = $1", [B]);
      expect(rest.rows[0].n).toBe(1);
    } finally {
      await db.admin.query("rollback");
    }
  });
});
