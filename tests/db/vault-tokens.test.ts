// Mail tokens in Supabase Vault (supabase/migrations/20261123130000_mail_token_vault.sql),
// tested through lib/mail/token-store.ts's Vault store on a real Postgres with the Vault
// stand-in from tests/db/supabase-shim.sql.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVaultTokenStore, type OAuthTokens, type Rpc } from "../../lib/mail/token-store";
import { as, attempt, createTestDatabase, databaseUrl, type Actor, type TestDatabase } from "./harness";

const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const tokens = (n: number): OAuthTokens => ({
  accessToken: `invented-access-${n}`,
  refreshToken: `invented-refresh-${n}`,
  expiresAt: 1795000000000 + n,
  scope: READONLY,
});

const FUNCTIONS: [string, string, (ids: { user: string; conn: string }) => unknown[]][] = [
  ["mail_connection_save", "$1::uuid, 'gmail', 'x@mail.example', '{}'", ({ user }) => [user]],
  ["mail_connection_tokens", "$1::uuid", ({ conn }) => [conn]],
  ["mail_connection_update_tokens", "$1::uuid, '{}'", ({ conn }) => [conn]],
  ["mail_connection_remove", "$1::uuid", ({ conn }) => [conn]],
];

describe.skipIf(!databaseUrl)("mail tokens in Supabase Vault", () => {
  let db: TestDatabase;
  let rpc: Rpc;
  const A = randomUUID();
  const B = randomUUID();

  const secretCount = async () => Number((await db.admin.query("select count(*) from vault.secrets")).rows[0].count);
  const connection = async (id: string) =>
    (await db.admin.query("select * from public.mail_connections where id = $1", [id])).rows[0];

  beforeAll(async () => {
    db = await createTestDatabase();
    for (const id of [A, B]) await db.admin.query("insert into auth.users (id) values ($1)", [id]);
    // The server's RPC, as the service role (what supabase-js does with the service key).
    rpc = async (fn, args) => {
      const names = Object.keys(args);
      const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")}) as result`;
      const r = await as(db.admin, { kind: "service" }, (q) => q(sql, names.map((n) => args[n])));
      return r.rows[0].result;
    };
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it("save stores the tokens in Vault and only the secret id in mail_connections", async () => {
    const store = createVaultTokenStore(rpc);
    const before = await secretCount();
    const id = await store.saveConnection({ userId: A, provider: "gmail", accountAddress: "Reader@Inbox.example" }, tokens(1));
    expect(await secretCount()).toBe(before + 1);
    const row = await connection(id);
    expect(row.user_id).toBe(A);
    expect(row.account_address).toBe("reader@inbox.example");
    expect(row.status).toBe("active");
    const secret = (await db.admin.query("select name, secret from vault.secrets where id = $1", [row.token_secret_id])).rows[0];
    expect(secret.name).toBe(`mail_connection:${id}`);
    expect(JSON.parse(secret.secret).refresh_token).toBe("invented-refresh-1");
    // No column of the row holds a token.
    expect(JSON.stringify(row)).not.toContain("invented-");
    expect(await store.read(id)).toEqual(tokens(1));
  });

  it("reconnecting the same mailbox replaces the secret's value (no second secret) and reactivates", async () => {
    const store = createVaultTokenStore(rpc);
    const ref = { userId: A, provider: "gmail" as const, accountAddress: "again@inbox.example" };
    const id = await store.saveConnection(ref, tokens(2));
    await db.admin.query("update public.mail_connections set status = 'error' where id = $1", [id]);
    const count = await secretCount();
    expect(await store.saveConnection(ref, tokens(3))).toBe(id);
    expect(await secretCount()).toBe(count);
    expect(await store.read(id)).toEqual(tokens(3));
    expect((await connection(id)).status).toBe("active");
  });

  it("update replaces the tokens after a refresh", async () => {
    const store = createVaultTokenStore(rpc);
    const id = await store.saveConnection({ userId: A, provider: "gmail", accountAddress: "upd@inbox.example" }, tokens(4));
    await store.update(id, tokens(5));
    expect(await store.read(id)).toEqual(tokens(5));
    await expect(store.update(randomUUID(), tokens(6))).rejects.toThrow(/no such mail connection/);
  });

  it("removing a connection deletes its Vault secret", async () => {
    const store = createVaultTokenStore(rpc);
    const id = await store.saveConnection({ userId: A, provider: "gmail", accountAddress: "rm@inbox.example" }, tokens(7));
    const secretId = (await connection(id)).token_secret_id;
    const count = await secretCount();
    await store.removeConnection(id);
    expect(await connection(id)).toBeUndefined();
    expect(await secretCount()).toBe(count - 1);
    expect((await db.admin.query("select 1 from vault.secrets where id = $1", [secretId])).rowCount).toBe(0);
    await expect(store.read(id)).rejects.toThrow(/No stored tokens/);
  });

  it("deleting the user deletes their connections' Vault secrets too", async () => {
    const store = createVaultTokenStore(rpc);
    const user = randomUUID();
    await db.admin.query("insert into auth.users (id) values ($1)", [user]);
    const ids = [
      await store.saveConnection({ userId: user, provider: "gmail", accountAddress: "one@inbox.example" }, tokens(8)),
      await store.saveConnection({ userId: user, provider: "gmail", accountAddress: "two@inbox.example" }, tokens(9)),
    ];
    const secretIds = (await db.admin.query("select token_secret_id from public.mail_connections where id = any($1)", [ids])).rows.map(
      (r) => r.token_secret_id,
    );
    await db.admin.query("delete from auth.users where id = $1", [user]);
    expect((await db.admin.query("select 1 from vault.secrets where id = any($1)", [secretIds])).rowCount).toBe(0);
  });

  it("one user's tokens are not touched by another user's connection", async () => {
    const store = createVaultTokenStore(rpc);
    const a = await store.saveConnection({ userId: A, provider: "gmail", accountAddress: "same@inbox.example" }, tokens(10));
    const b = await store.saveConnection({ userId: B, provider: "gmail", accountAddress: "same@inbox.example" }, tokens(11));
    expect(a).not.toBe(b);
    await store.removeConnection(b);
    expect(await store.read(a)).toEqual(tokens(10));
  });

  describe("only the server (service_role) can use the token functions or Vault", () => {
    const actors: [string, Actor][] = [
      ["anon", { kind: "anon" }],
      ["user A", { kind: "user", id: A }],
      ["user B", { kind: "user", id: B }],
    ];

    it.each(actors)("%s cannot execute any token function", async (_label, actor) => {
      const store = createVaultTokenStore(rpc);
      const conn = await store.saveConnection({ userId: A, provider: "gmail", accountAddress: `fn-${randomUUID()}@inbox.example` }, tokens(12));
      for (const [fn, argSql, params] of FUNCTIONS) {
        const r = await attempt(db.admin, actor, `select public.${fn}(${argSql})`, params({ user: A, conn }));
        expect(r.error?.code, fn).toBe("42501");
      }
      expect(await store.read(conn)).toEqual(tokens(12));
    });

    it.each(actors)("%s cannot read Vault directly", async (_label, actor) => {
      for (const sql of ["select * from vault.secrets", "select * from vault.decrypted_secrets", "select vault.create_secret('x')"]) {
        const r = await attempt(db.admin, actor, sql);
        expect(r.error?.code, sql).toBe("42501");
      }
    });

    it("signed-in users still cannot read token_secret_id", async () => {
      const r = await attempt(db.admin, { kind: "user", id: A }, "select token_secret_id from public.mail_connections");
      expect(r.error?.code).toBe("42501");
    });

    it("every function in public is closed to anon and authenticated", async () => {
      const open = await db.admin.query(
        `select p.proname, r.rolname
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         cross join (values ('anon'), ('authenticated')) as r(rolname)
         where n.nspname = 'public' and has_function_privilege(r.rolname, p.oid, 'execute')
         order by 1, 2`,
      );
      expect(open.rows).toEqual([]);
    });

    it("the token functions are security definer with an empty search_path", async () => {
      const r = await db.admin.query(
        `select proname, prosecdef, proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname in ('public', 'private') and proname like 'mail_connection%' order by 1`,
      );
      expect(r.rows.map((x) => x.proname)).toEqual([
        "mail_connection_delete_secret",
        "mail_connection_remove",
        "mail_connection_save",
        "mail_connection_tokens",
        "mail_connection_update_tokens",
      ]);
      for (const row of r.rows) {
        expect(row.prosecdef, row.proname).toBe(true);
        expect(row.proconfig, row.proname).toEqual(['search_path=""']);
      }
    });
  });
});
