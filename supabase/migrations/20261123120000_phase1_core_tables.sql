-- Phase 1 core tables: user settings, newsletter sources, mail connections, newsletters
-- and summaries.
--
-- Access model (tested in tests/db/rls.test.ts):
--   * Row-level security on every table; every policy is for the authenticated role and
--     keyed on auth.uid(). No policy exists for anon, and anon holds no table privilege.
--   * user_settings and newsletter_sources: a signed-in user reads and writes their own rows.
--   * mail_connections, newsletters and summaries: a signed-in user reads their own rows;
--     only the server (service_role, which bypasses RLS) writes them.
--   * OAuth tokens never sit in a table column. mail_connections.token_secret_id holds the
--     id of the Supabase Vault secret that stores them, and signed-in users cannot read
--     even that id.
--
-- Supabase grants every new public table to anon, authenticated and service_role by
-- default, so each table below starts by revoking those grants and adding back only what
-- the access model needs.

-- Helper schema, not exposed through the Supabase API (only public is, by default).
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

create or replace function private.is_valid_timezone(tz text) returns boolean
language sql stable
set search_path = ''
as $$
  select exists (select 1 from pg_catalog.pg_timezone_names where name = tz)
$$;
revoke all on function private.is_valid_timezone(text) from public;
grant execute on function private.is_valid_timezone(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------
-- user_settings: one row per user.
create table public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- Local wall-clock time the briefing should be ready, in `timezone`.
  delivery_time time not null default '07:00',
  timezone text not null default 'UTC' check (private.is_valid_timezone(timezone)),
  summary_length text not null default 'brief'
    check (summary_length in ('headline', 'brief', 'deep')),
  voice text not null default 'af_heart' check (voice in ('af_heart', 'bm_daniel')),
  speed numeric(3, 2) not null default 1.00 check (speed between 0.50 and 2.00),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;
revoke all on table public.user_settings from anon, authenticated;
grant select, insert, delete on table public.user_settings to authenticated;
grant update (delivery_time, timezone, summary_length, voice, speed, updated_at)
  on table public.user_settings to authenticated;

create policy "user_settings: read own" on public.user_settings
  for select to authenticated using (user_id = (select auth.uid()));
create policy "user_settings: insert own" on public.user_settings
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "user_settings: update own" on public.user_settings
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "user_settings: delete own" on public.user_settings
  for delete to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------------------
-- newsletter_sources: which senders count as newsletters for this user, and whether each
-- is included in the briefing.
create table public.newsletter_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  sender_address text not null
    check (sender_address = lower(sender_address) and length(sender_address) between 3 and 320),
  display_name text check (length(display_name) <= 200),
  included boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, sender_address)
);

alter table public.newsletter_sources enable row level security;
revoke all on table public.newsletter_sources from anon, authenticated;
grant select, insert, delete on table public.newsletter_sources to authenticated;
grant update (display_name, included) on table public.newsletter_sources to authenticated;

create policy "newsletter_sources: read own" on public.newsletter_sources
  for select to authenticated using (user_id = (select auth.uid()));
create policy "newsletter_sources: insert own" on public.newsletter_sources
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "newsletter_sources: update own" on public.newsletter_sources
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "newsletter_sources: delete own" on public.newsletter_sources
  for delete to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------------------
-- mail_connections: one row per connected mailbox. Written only by the server (OAuth
-- callback and pull job).
create table public.mail_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('gmail', 'outlook')),
  account_address text not null check (length(account_address) between 3 and 320),
  -- id of the vault.secrets row holding this connection's OAuth tokens. The tokens
  -- themselves are never stored in a table. Removing a connection must also delete its
  -- Vault secret (server side).
  token_secret_id uuid not null unique,
  status text not null default 'active' check (status in ('active', 'revoked', 'error')),
  created_at timestamptz not null default now(),
  last_synced_at timestamptz,
  unique (user_id, provider, account_address),
  -- Target of the composite foreign key from newsletters.
  unique (id, user_id)
);

alter table public.mail_connections enable row level security;
revoke all on table public.mail_connections from anon, authenticated;
-- Every column except token_secret_id.
grant select (id, user_id, provider, account_address, status, created_at, last_synced_at)
  on table public.mail_connections to authenticated;

create policy "mail_connections: read own" on public.mail_connections
  for select to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------------------
-- newsletters: pulled messages, as plain text. Written only by the server.
create table public.newsletters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  connection_id uuid not null,
  provider_message_id text not null,
  sender_address text not null,
  sender_name text,
  subject text not null default '',
  received_at timestamptz not null,
  body_text text not null,
  created_at timestamptz not null default now(),
  unique (connection_id, provider_message_id),
  unique (id, user_id),
  -- The connection must belong to the same user.
  foreign key (connection_id, user_id)
    references public.mail_connections (id, user_id) on delete cascade
);

create index newsletters_user_received_idx on public.newsletters (user_id, received_at desc);

alter table public.newsletters enable row level security;
revoke all on table public.newsletters from anon, authenticated;
grant select on table public.newsletters to authenticated;

create policy "newsletters: read own" on public.newsletters
  for select to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------------------
-- summaries: one per newsletter and length. Written only by the server.
create table public.summaries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  newsletter_id uuid not null,
  length text not null check (length in ('headline', 'brief', 'deep')),
  summary_text text not null,
  created_at timestamptz not null default now(),
  unique (newsletter_id, length),
  -- The newsletter must belong to the same user.
  foreign key (newsletter_id, user_id)
    references public.newsletters (id, user_id) on delete cascade
);

create index summaries_user_idx on public.summaries (user_id, created_at desc);

alter table public.summaries enable row level security;
revoke all on table public.summaries from anon, authenticated;
grant select on table public.summaries to authenticated;

create policy "summaries: read own" on public.summaries
  for select to authenticated using (user_id = (select auth.uid()));
