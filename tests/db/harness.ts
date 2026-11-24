// Test database harness for the Supabase migrations.
//
// Needs a real Postgres server, given by DATABASE_URL (a superuser connection to a LOCAL
// server only). For every run it creates a fresh, randomly named database, applies
// tests/db/supabase-shim.sql (the roles and auth functions Supabase provides) and then
// every file in supabase/migrations/ in name order, and drops the database afterwards.
//
// It never touches the database named in DATABASE_URL beyond CREATE/DROP DATABASE, and it
// refuses any host other than localhost, so it cannot be pointed at a real Supabase project.
//
// Without DATABASE_URL the tests skip with a message; with CI=true or REQUIRE_DB=1 they
// fail instead, so CI can never pass by skipping them.

import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
export const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");
const SHIM = path.join(HERE, "supabase-shim.sql");

/** Advisory lock key for database setup (any constant; "impartly" in ASCII). */
const SETUP_LOCK = 0x696d7061;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export const dbRequired = process.env.CI === "true" || process.env.REQUIRE_DB === "1";
export const databaseUrl = process.env.DATABASE_URL ?? "";

/** Throws unless the URL points at a local server. Exported for its own test. */
export function assertLocalDatabaseUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must start with postgres:// or postgresql://");
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `DATABASE_URL host "${parsed.hostname}" is not local. These tests create roles and ` +
        "databases, so they only run against a throwaway local Postgres, never a real project.",
    );
  }
  return parsed;
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

export interface TestDatabase {
  /** Superuser connection to the fresh test database (bypasses RLS: use for setup). */
  admin: pg.Client;
  name: string;
  /** Another superuser connection to the same test database (for concurrency tests). */
  connect(): Promise<pg.Client>;
  close(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const base = assertLocalDatabaseUrl(databaseUrl);
  const name = `impartly_test_${randomBytes(6).toString("hex")}`;

  // Test files run in parallel workers, and the shim creates cluster-wide roles. Hold an
  // advisory lock on the shared root database while setting up, so two workers never
  // create the same role at once.
  const root = new pg.Client({ connectionString: base.toString() });
  await root.connect();
  let admin: pg.Client | undefined;
  try {
    await root.query("select pg_advisory_lock($1)", [SETUP_LOCK]);
    await root.query(`create database ${name}`);

    const testUrl = new URL(base.toString());
    testUrl.pathname = `/${name}`;
    admin = new pg.Client({ connectionString: testUrl.toString() });
    await admin.connect();

    await applySql(admin, "supabase-shim.sql", readFileSync(SHIM, "utf8"));
    for (const file of migrationFiles()) {
      await applySql(admin, file, readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
    }
  } catch (err) {
    await admin?.end();
    await root.end(); // also releases the lock
    await dropDatabase(base, name);
    throw err;
  }
  await root.end(); // releases the lock
  const client = admin;
  const extra: pg.Client[] = [];

  return {
    admin: client,
    name,
    async connect() {
      const url = new URL(base.toString());
      url.pathname = `/${name}`;
      const c = new pg.Client({ connectionString: url.toString() });
      await c.connect();
      extra.push(c);
      return c;
    },
    async close() {
      await Promise.all(extra.map((c) => c.end().catch(() => undefined)));
      await client.end();
      await dropDatabase(base, name);
    },
  };
}

async function applySql(client: pg.Client, label: string, sql: string) {
  try {
    await client.query("begin");
    await client.query(sql);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw new Error(`applying ${label} failed: ${(err as Error).message}`);
  }
}

async function dropDatabase(base: URL, name: string) {
  const root = new pg.Client({ connectionString: base.toString() });
  await root.connect();
  try {
    await root.query(`drop database if exists ${name} with (force)`);
  } finally {
    await root.end();
  }
}

export type Actor =
  | { kind: "anon" }
  | { kind: "user"; id: string }
  | { kind: "service" };

/**
 * Runs `fn` in a transaction as the given API role, the way Supabase's API does for a
 * request: SET LOCAL ROLE plus request.jwt.claims. The transaction is committed if `fn`
 * succeeds and rolled back if it throws; the error is rethrown.
 */
export async function as<T>(
  client: pg.Client,
  actor: Actor,
  fn: (q: (sql: string, params?: unknown[]) => Promise<pg.QueryResult>) => Promise<T>,
): Promise<T> {
  const role =
    actor.kind === "anon" ? "anon" : actor.kind === "user" ? "authenticated" : "service_role";
  const claims =
    actor.kind === "user" ? { sub: actor.id, role } : { role };
  await client.query("begin");
  try {
    await client.query(`set local role ${role}`);
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(claims),
    ]);
    const result = await fn((sql, params) => client.query(sql, params));
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

/** Like `as`, but returns the Postgres error (or null) instead of throwing. */
export async function attempt(
  client: pg.Client,
  actor: Actor,
  sql: string,
  params?: unknown[],
): Promise<{ error: (Error & { code?: string }) | null; rowCount: number; rows: unknown[] }> {
  try {
    const r = await as(client, actor, (q) => q(sql, params));
    return { error: null, rowCount: r.rowCount ?? 0, rows: r.rows };
  } catch (err) {
    return { error: err as Error & { code?: string }, rowCount: 0, rows: [] };
  }
}
