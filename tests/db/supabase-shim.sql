-- Test-only stand-in for what a Supabase project provides before our migrations run.
-- Never applied to a real Supabase project: there these objects already exist.
--
-- Mirrors, in the parts our migrations and RLS policies depend on:
--   * the API roles anon, authenticated and service_role (service_role bypasses RLS);
--   * auth.users (id only) and auth.uid() / auth.role() / auth.jwt(), which read the
--     request.jwt.claims setting the way Supabase's PostgREST requests set it;
--   * Supabase's default grants: every new table in public is granted to anon,
--     authenticated and service_role, so RLS and our own revokes are what protect it.
--     Leaving these grants out would make the tests pass more easily than real Supabase.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text
);

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create or replace function auth.role() returns text
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create or replace function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.role(), auth.jwt() to anon, authenticated, service_role;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

-- Supabase Vault (the supabase_vault extension), minimal stand-in. Same names and
-- signatures our migrations use: vault.secrets, vault.decrypted_secrets,
-- vault.create_secret and vault.update_secret. Real Vault encrypts `secret` at rest and
-- decrypts it in the view; this stand-in stores plain text, which is fine for a throwaway
-- test database holding invented tokens. Like Supabase, the API roles get no access to
-- the vault schema: our server reaches it only through the migration's functions.
create schema if not exists vault;

create table if not exists vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text,
  description text not null default '',
  secret text not null,
  key_id uuid,
  nonce bytea,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists secrets_name_idx on vault.secrets (name) where name is not null;

create or replace view vault.decrypted_secrets as
  select id, name, description, secret, secret as decrypted_secret, key_id, nonce, created_at, updated_at
  from vault.secrets;

create or replace function vault.create_secret(
  new_secret text,
  new_name text default null,
  new_description text default '',
  new_key_id uuid default null
) returns uuid
language sql
as $$
  insert into vault.secrets (secret, name, description, key_id)
  values (new_secret, new_name, coalesce(new_description, ''), new_key_id)
  returning id
$$;

create or replace function vault.update_secret(
  secret_id uuid,
  new_secret text default null,
  new_name text default null,
  new_description text default null,
  new_key_id uuid default null
) returns void
language sql
as $$
  update vault.secrets set
    secret = coalesce(new_secret, secret),
    name = coalesce(new_name, name),
    description = coalesce(new_description, description),
    key_id = coalesce(new_key_id, key_id),
    updated_at = now()
  where id = secret_id
$$;

revoke all on schema vault from public, anon, authenticated, service_role;
revoke all on all tables in schema vault from public, anon, authenticated, service_role;
revoke all on all functions in schema vault from public, anon, authenticated, service_role;

-- Supabase Cron (pg_cron) and pg_net, minimal stand-ins. A plain Postgres has neither
-- extension, so the scheduled-pull migration finds these schemas and skips CREATE
-- EXTENSION. cron.schedule keeps jobs in cron.job (a job of the same name is replaced,
-- as pg_cron does); nothing runs them. net.http_post only records the request in
-- net.http_request_queue (the table real pg_net queues requests in) and sends nothing.
create schema if not exists cron;

create table if not exists cron.job (
  jobid bigserial primary key,
  jobname text unique,
  schedule text not null,
  command text not null,
  username text not null default current_user,
  active boolean not null default true
);

create or replace function cron.schedule(job_name text, schedule text, command text) returns bigint
language sql
as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid
$$;

create schema if not exists net;

create table if not exists net.http_request_queue (
  id bigserial primary key,
  method text not null,
  url text not null,
  headers jsonb not null,
  body jsonb,
  timeout_milliseconds integer not null
);

create or replace function net.http_post(
  url text,
  body jsonb default '{}'::jsonb,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds integer default 2000
) returns bigint
language sql
as $$
  insert into net.http_request_queue (method, url, headers, body, timeout_milliseconds)
  values ('POST', url, headers, body, timeout_milliseconds)
  returning id
$$;

revoke all on schema cron, net from public, anon, authenticated, service_role;
revoke all on all tables in schema cron, net from public, anon, authenticated, service_role;
revoke all on all functions in schema cron, net from public, anon, authenticated, service_role;
