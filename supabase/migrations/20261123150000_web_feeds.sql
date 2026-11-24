-- Web feeds: newsletters the user picked, read from their public RSS or Atom feeds
-- (GOAL.md Phase 1). Adds one table (web_feeds), lets a newsletter come from either a
-- mail connection or a web feed, and adds the server-only functions the pipeline and the
-- feed picker call.
--
-- Access model (tested in tests/db/rls.test.ts and tests/db/web-feeds.test.ts):
--   * web_feeds has row-level security; a signed-in user reads only their own rows.
--   * Only the server (service_role) writes web_feeds: a feed URL is stored only after the
--     server has fetched it and found a valid feed (lib/sources/web/discover.ts), so a
--     user cannot store an arbitrary URL for the pipeline to fetch.
--   * Every function below takes the user id and touches only that user's rows, and is
--     executable by service_role only.

-- ---------------------------------------------------------------------------------------
-- web_feeds: one row per feed a user picked.
create table public.web_feeds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The URL that answered with a valid feed (after redirects).
  feed_url text not null check (feed_url ~ '^https?://' and length(feed_url) <= 2048),
  feed_format text not null check (feed_format in ('rss', 'atom')),
  title text not null check (length(title) between 1 and 200),
  homepage_url text check (homepage_url ~ '^https?://' and length(homepage_url) <= 2048),
  -- The data/newsletter-catalog.json entry it came from, if any.
  catalog_id text check (catalog_id ~ '^[a-z0-9][a-z0-9-]{1,60}$'),
  included boolean not null default true,
  -- HTTP cache validators from the last successful fetch (conditional GET).
  etag text check (length(etag) <= 512),
  last_modified text check (length(last_modified) <= 100),
  last_fetched_at timestamptz,
  -- Short code of the last failed fetch (e.g. 'http_404', 'robots_disallowed'), cleared on success.
  last_error text check (last_error ~ '^[a-z0-9_+]{1,40}$'),
  created_at timestamptz not null default now(),
  unique (user_id, feed_url),
  -- Target of the composite foreign key from newsletters.
  unique (id, user_id)
);

alter table public.web_feeds enable row level security;
revoke all on table public.web_feeds from anon, authenticated;
grant select on table public.web_feeds to authenticated;

create policy "web_feeds: read own" on public.web_feeds
  for select to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------------------
-- newsletters: from a mail connection OR a web feed (exactly one).
alter table public.newsletters alter column connection_id drop not null;
alter table public.newsletters add column feed_id uuid;
alter table public.newsletters
  add constraint newsletters_feed_same_user
  foreign key (feed_id, user_id) references public.web_feeds (id, user_id) on delete cascade;
alter table public.newsletters
  add constraint newsletters_one_source check (num_nonnulls(connection_id, feed_id) = 1);
-- De-duplication for feed items: provider_message_id holds the item key (guid, else link).
alter table public.newsletters
  add constraint newsletters_feed_item_unique unique (feed_id, provider_message_id);
-- Only part of the issue was public (teaser or paywall notice); the rest was never fetched.
alter table public.newsletters add column partial boolean not null default false;
-- The item's own link (web feeds only).
alter table public.newsletters
  add column source_url text check (source_url ~ '^https?://' and length(source_url) <= 2048);

-- ---------------------------------------------------------------------------------------
-- pipeline_load now also returns the user's web feeds.
create or replace function public.pipeline_load(p_user_id uuid) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'summary_length',
      coalesce((select s.summary_length from public.user_settings s where s.user_id = p_user_id), 'brief'),
    'sources', coalesce((
      select jsonb_agg(jsonb_build_object('sender_address', ns.sender_address, 'included', ns.included)
                       order by ns.sender_address)
      from public.newsletter_sources ns where ns.user_id = p_user_id), '[]'::jsonb),
    'connections', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'provider', c.provider, 'status', c.status,
               'last_synced_at', c.last_synced_at) order by c.created_at)
      from public.mail_connections c where c.user_id = p_user_id), '[]'::jsonb),
    'feeds', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', f.id, 'feed_url', f.feed_url, 'title', f.title, 'included', f.included,
               'etag', f.etag, 'last_modified', f.last_modified,
               'last_fetched_at', f.last_fetched_at) order by f.created_at)
      from public.web_feeds f where f.user_id = p_user_id), '[]'::jsonb)
  )
$$;

-- ---------------------------------------------------------------------------------------
-- Stores one feed item. Returns {"id": ..., "inserted": true|false}; an item already
-- stored for this feed (same key) is not stored again.
create or replace function public.pipeline_save_feed_item(
  p_user_id uuid,
  p_feed_id uuid,
  p_item_key text,
  p_sender_address text,
  p_sender_name text,
  p_subject text,
  p_received_at timestamptz,
  p_body_text text,
  p_partial boolean,
  p_source_url text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.newsletters
    (user_id, feed_id, provider_message_id, sender_address, sender_name, subject, received_at,
     body_text, partial, source_url)
  values
    (p_user_id, p_feed_id, left(p_item_key, 600), lower(p_sender_address), left(p_sender_name, 200),
     coalesce(left(p_subject, 500), ''), p_received_at, p_body_text, coalesce(p_partial, false),
     case when p_source_url ~ '^https?://' and length(p_source_url) <= 2048 then p_source_url end)
  on conflict (feed_id, provider_message_id) do nothing
  returning id into v_id;

  if v_id is not null then
    return jsonb_build_object('id', v_id, 'inserted', true);
  end if;

  select n.id into v_id from public.newsletters n
  where n.feed_id = p_feed_id
    and n.provider_message_id = left(p_item_key, 600)
    and n.user_id = p_user_id;
  if v_id is null then
    raise exception 'feed item conflict outside this user' using errcode = 'P0002';
  end if;
  return jsonb_build_object('id', v_id, 'inserted', false);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Records a feed fetch. Success (p_error null): last_fetched_at, the cache validators,
-- and last_error cleared. Failure: only last_error. Only the user's own feed.
create or replace function public.pipeline_mark_feed(
  p_user_id uuid,
  p_feed_id uuid,
  p_fetched_at timestamptz,
  p_etag text,
  p_last_modified text,
  p_error text
) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if p_error is not null then
    update public.web_feeds f set last_error = p_error
    where f.id = p_feed_id and f.user_id = p_user_id;
  else
    update public.web_feeds f
    set last_fetched_at = coalesce(p_fetched_at, f.last_fetched_at),
        etag = left(p_etag, 512),
        last_modified = left(p_last_modified, 100),
        last_error = null
    where f.id = p_feed_id and f.user_id = p_user_id;
  end if;
  if not found then
    raise exception 'no such web feed for this user' using errcode = 'P0002';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Stores a feed the server has discovered and validated for this user. Picking the same
-- feed again switches it back on and keeps its history. Returns {"id", "inserted"}.
create or replace function public.feeds_subscribe(
  p_user_id uuid,
  p_feed_url text,
  p_feed_format text,
  p_title text,
  p_homepage_url text,
  p_catalog_id text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_inserted boolean;
begin
  insert into public.web_feeds (user_id, feed_url, feed_format, title, homepage_url, catalog_id)
  values (p_user_id, p_feed_url, p_feed_format, left(p_title, 200), p_homepage_url, p_catalog_id)
  on conflict (user_id, feed_url) do update set included = true
  returning id, (xmax = 0) into v_id, v_inserted;
  return jsonb_build_object('id', v_id, 'inserted', v_inserted);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Server only.
revoke all on function public.pipeline_save_feed_item(uuid, uuid, text, text, text, text, timestamptz, text, boolean, text) from public, anon, authenticated;
revoke all on function public.pipeline_mark_feed(uuid, uuid, timestamptz, text, text, text) from public, anon, authenticated;
revoke all on function public.feeds_subscribe(uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.pipeline_save_feed_item(uuid, uuid, text, text, text, text, timestamptz, text, boolean, text) to service_role;
grant execute on function public.pipeline_mark_feed(uuid, uuid, timestamptz, text, text, text) to service_role;
grant execute on function public.feeds_subscribe(uuid, text, text, text, text, text) to service_role;
-- pipeline_load was replaced above; `create or replace` keeps its existing grants, but
-- state them again so this file reads on its own.
revoke all on function public.pipeline_load(uuid) from public, anon, authenticated;
grant execute on function public.pipeline_load(uuid) to service_role;
