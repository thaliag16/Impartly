-- The newsletter picker (GOAL.md Phase 1): switch a feed on or off, remove it, and a
-- per-user rate limit on feed discovery (each discovery makes outbound requests).
--
-- Access model (tested in tests/db/feed-picker.test.ts and tests/db/rls.test.ts):
--   * web_feeds stays written by the server only; the two functions below take the user
--     id and touch only that user's feed, and only service_role may call them.
--   * The rate-limit log lives in the private schema (not exposed by the Supabase API),
--     with row-level security on and no privileges for anon or authenticated users.

-- ---------------------------------------------------------------------------------------
-- Discovery attempts, one row per attempt, kept only for the rate-limit window.
create table private.feed_discovery_attempts (
  user_id uuid not null references auth.users (id) on delete cascade,
  attempted_at timestamptz not null default now()
);
create index feed_discovery_attempts_user_time on private.feed_discovery_attempts (user_id, attempted_at);

alter table private.feed_discovery_attempts enable row level security;
revoke all on table private.feed_discovery_attempts from public, anon, authenticated, service_role;
-- No policies: nobody reads or writes it except through feeds_discovery_take below.

-- Takes one discovery attempt for this user if fewer than p_limit were taken in the last
-- p_window_seconds. Returns true when allowed (and records it), false when over the limit.
-- A per-user advisory lock makes concurrent calls count correctly.
create or replace function public.feeds_discovery_take(
  p_user_id uuid,
  p_limit integer,
  p_window_seconds integer
) returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_user_id is null or p_limit is null or p_limit < 1 or p_limit > 1000
     or p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'invalid rate limit arguments' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('feeds_discovery_take:' || p_user_id::text, 0));
  delete from private.feed_discovery_attempts a
  where a.user_id = p_user_id and a.attempted_at < now() - make_interval(secs => p_window_seconds);
  select count(*) into v_count from private.feed_discovery_attempts a where a.user_id = p_user_id;
  if v_count >= p_limit then
    return false;
  end if;
  insert into private.feed_discovery_attempts (user_id) values (p_user_id);
  return true;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Switches one of the user's feeds on or off. Returns false if the user has no such feed.
create or replace function public.feeds_set_included(
  p_user_id uuid,
  p_feed_id uuid,
  p_included boolean
) returns boolean
language plpgsql security definer
set search_path = ''
as $$
begin
  if p_included is null then
    raise exception 'included must be true or false' using errcode = '22023';
  end if;
  update public.web_feeds f set included = p_included
  where f.id = p_feed_id and f.user_id = p_user_id;
  return found;
end;
$$;

-- Removes one of the user's feeds (its stored issues and their summaries go with it, by
-- the existing cascades). Returns false if the user has no such feed.
create or replace function public.feeds_remove(
  p_user_id uuid,
  p_feed_id uuid
) returns boolean
language plpgsql security definer
set search_path = ''
as $$
begin
  delete from public.web_feeds f where f.id = p_feed_id and f.user_id = p_user_id;
  return found;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Server only.
revoke all on function public.feeds_discovery_take(uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.feeds_set_included(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.feeds_remove(uuid, uuid) from public, anon, authenticated;
grant execute on function public.feeds_discovery_take(uuid, integer, integer) to service_role;
grant execute on function public.feeds_set_included(uuid, uuid, boolean) to service_role;
grant execute on function public.feeds_remove(uuid, uuid) to service_role;
