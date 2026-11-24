-- Scheduled pull (GOAL.md Phase 1: "Scheduled pull runs at a user-set time via Supabase
-- Cron"). Supabase Cron (pg_cron) calls the app's pull route every 5 minutes through
-- pg_net; the route (app/api/cron/pull, lib/schedule) claims the users whose briefing is
-- coming due and runs the pipeline for them inside the function's time limit.
--
-- Safe on a fresh project:
--   * the extensions are created only if they are not there yet;
--   * the job reads the route's URL and CRON_SECRET from Supabase Vault at every tick.
--     Neither value is in this file or the repository. Until both Vault secrets exist the
--     tick does nothing (it logs a notice), so applying this migration calls nothing;
--   * cron.schedule with a job name replaces a job of the same name, so it never doubles.
--
-- Access model (tested in tests/db/scheduled-pull.test.ts and tests/db/rls.test.ts):
--   * private.pull_schedule (one row per user: which delivery the last completed pull was
--     for, the lease, the failure backoff) has RLS on and no privileges for anon,
--     authenticated or service_role; only the functions below touch it.
--   * pull_claim_next and pull_finish are security definer, empty search_path,
--     service_role only. pipeline_begin_feed likewise; it touches only the given user's feed.
--   * private.cron_pull_tick is callable by no API role; pg_cron runs it as the role that
--     scheduled it (postgres on Supabase).

-- ---------------------------------------------------------------------------------------
-- Extensions. On Supabase both are available (pg_cron in pg_catalog, pg_net in
-- extensions, as Supabase's docs install them). A project where Cron or pg_net was
-- already switched on from the dashboard keeps its install. The test shim
-- (tests/db/supabase-shim.sql) provides stand-in cron and net schemas, so it skips these.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_namespace where nspname = 'cron') then
    create extension if not exists pg_cron with schema pg_catalog;
  end if;
  if not exists (select 1 from pg_catalog.pg_namespace where nspname = 'net') then
    create schema if not exists extensions;
    create extension if not exists pg_net with schema extensions;
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Schedule math: when is "07:00 in America/New_York" on a given local date?
--
-- Most days it is one instant. On a daylight saving change it may not be:
--   * clocks go back (an hour repeats): 01:30 happens twice. We take the FIRST, so the
--     briefing is ready the first time the clock shows the set time.
--   * clocks go forward (an hour is skipped): 02:30 never happens. We take the moment
--     the clock jumps (03:00 local in New York), the first instant at or after the set
--     time on the wall clock. (Postgres alone would give 03:30, half an hour late.)
-- The offsets one day either side of the plain conversion are the offsets before and
-- after any change that day (time zone changes are never a day apart).
create or replace function private.local_to_instant(p_local timestamp, p_tz text)
returns timestamptz
language plpgsql stable
set search_path = ''
as $$
declare
  v_plain timestamptz := p_local at time zone p_tz;
  v_before interval := ((v_plain - interval '1 day') at time zone p_tz) - ((v_plain - interval '1 day') at time zone 'UTC');
  v_after interval := ((v_plain + interval '1 day') at time zone p_tz) - ((v_plain + interval '1 day') at time zone 'UTC');
  v_a timestamptz := (p_local - v_before) at time zone 'UTC';
  v_b timestamptz := (p_local - v_after) at time zone 'UTC';
  v_lo timestamptz := least(v_a, v_b);
  v_hi timestamptz := greatest(v_a, v_b);
  v_found timestamptz;
begin
  -- Normal day, or the repeated hour: the earliest instant that reads p_local.
  if (v_lo at time zone p_tz) = p_local then return v_lo; end if;
  if (v_hi at time zone p_tz) = p_local then return v_hi; end if;
  -- Skipped hour: the first minute at which the wall clock reads p_local or later.
  select m into v_found
  from pg_catalog.generate_series(v_lo, v_hi, interval '1 minute') m
  where (m at time zone p_tz) >= p_local
  order by m
  limit 1;
  return coalesce(v_found, v_plain);
end;
$$;

-- The latest delivery instant whose pull should have started by p_now: the largest
-- delivery D (at p_time local, one per local date) with D - p_lead <= p_now. With a lead
-- of 30 minutes and delivery at 07:00, the pull for tomorrow's 07:00 is due from 06:30.
create or replace function private.delivery_due_at(p_now timestamptz, p_time time, p_tz text, p_lead interval)
returns timestamptz
language sql stable
set search_path = ''
as $$
  select max(d.at)
  from pg_catalog.generate_series(-2, 1) as g(days)
  cross join lateral (
    select private.local_to_instant(((p_now at time zone p_tz)::date + g.days) + p_time, p_tz) as at
  ) d
  where d.at - p_lead <= p_now
$$;

revoke all on function private.local_to_instant(timestamp, text) from public;
revoke all on function private.delivery_due_at(timestamptz, time, text, interval) from public;

-- ---------------------------------------------------------------------------------------
-- Per-source retry with backoff (web feeds). A scheduled pull marks the attempt BEFORE it
-- fetches, as if it will fail: failure_count + 1 and next_attempt_at pushed back. Success
-- (pipeline_mark_feed) clears both. So a source whose fetch outlasts the function (and
-- is cut off with it) counts as a failure too, and cannot block every later tick.
-- Backoff: 5 minutes, doubling per consecutive failure, at most 24 hours.
alter table public.web_feeds add column failure_count integer not null default 0 check (failure_count >= 0);
alter table public.web_feeds add column next_attempt_at timestamptz;
alter table public.web_feeds add column last_attempt_at timestamptz;

create or replace function private.retry_backoff(p_failures integer, p_base interval, p_max interval)
returns interval
language sql immutable
set search_path = ''
as $$
  select least(p_base * pg_catalog.power(2, least(greatest(p_failures, 1) - 1, 20))::integer, p_max)
$$;
revoke all on function private.retry_backoff(integer, interval, interval) from public;

-- Returns next_attempt_at: when the feed may be retried if this attempt fails.
create or replace function public.pipeline_begin_feed(p_user_id uuid, p_feed_id uuid, p_at timestamptz)
returns timestamptz
language plpgsql security definer
set search_path = ''
as $$
declare
  v_next timestamptz;
begin
  if p_at is null then
    raise exception 'p_at is required' using errcode = '22004';
  end if;
  update public.web_feeds f
  set failure_count = f.failure_count + 1,
      last_attempt_at = p_at,
      next_attempt_at = p_at + private.retry_backoff(f.failure_count + 1, interval '5 minutes', interval '24 hours')
  where f.id = p_feed_id and f.user_id = p_user_id
  returning f.next_attempt_at into v_next;
  if not found then
    raise exception 'no such web feed for this user' using errcode = 'P0002';
  end if;
  return v_next;
end;
$$;

-- Success now also clears the failure count and the retry time.
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
        last_error = null,
        failure_count = 0,
        next_attempt_at = null
    where f.id = p_feed_id and f.user_id = p_user_id;
  end if;
  if not found then
    raise exception 'no such web feed for this user' using errcode = 'P0002';
  end if;
end;
$$;

-- pipeline_load also returns each feed's failure count and retry time.
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
               'id', f.id, 'feed_url', f.feed_url, 'feed_format', f.feed_format, 'title', f.title,
               'included', f.included, 'etag', f.etag, 'last_modified', f.last_modified,
               'last_fetched_at', f.last_fetched_at,
               'failure_count', f.failure_count, 'next_attempt_at', f.next_attempt_at,
               'known_urls', case when f.feed_format = 'archive' then coalesce((
                 select jsonb_agg(v.u)
                 from (
                   select n.provider_message_id, n.source_url
                   from public.newsletters n
                   where n.feed_id = f.id and n.user_id = p_user_id
                   order by n.received_at desc, n.created_at desc
                   limit 50
                 ) recent
                 cross join lateral (values (recent.provider_message_id), (recent.source_url)) v(u)
                 where v.u is not null), '[]'::jsonb) else '[]'::jsonb end
             ) order by f.created_at)
      from public.web_feeds f where f.user_id = p_user_id), '[]'::jsonb)
  )
$$;

revoke all on function public.pipeline_begin_feed(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.pipeline_mark_feed(uuid, uuid, timestamptz, text, text, text) from public, anon, authenticated;
revoke all on function public.pipeline_load(uuid) from public, anon, authenticated;
grant execute on function public.pipeline_begin_feed(uuid, uuid, timestamptz) to service_role;
grant execute on function public.pipeline_mark_feed(uuid, uuid, timestamptz, text, text, text) to service_role;
grant execute on function public.pipeline_load(uuid) to service_role;

-- ---------------------------------------------------------------------------------------
-- private.pull_schedule: where each user's scheduled pull stands.
--
-- A "cycle" is the work for one delivery (cycle_due_for). It may take several ticks:
-- each tick runs until its time budget is spent and the next one carries on, skipping
-- sources already pulled since cycle_started_at. completed_for is the delivery the last
-- finished cycle was for; a user is due again when a later delivery comes due.
create table private.pull_schedule (
  user_id uuid primary key references auth.users (id) on delete cascade,
  cycle_due_for timestamptz,
  cycle_started_at timestamptz,
  completed_for timestamptz,
  -- Lease: the tick working on this user, and until when. Overlapping ticks skip leased
  -- users; a tick that dies leaves a lease that simply runs out.
  lease_owner uuid,
  lease_expires_at timestamptz,
  -- Not before this: a failed run's backoff, or the earliest retry of a source that failed.
  next_retry_at timestamptz,
  failure_count integer not null default 0 check (failure_count >= 0),
  last_error text check (last_error ~ '^[a-z0-9_+]{1,40}$'),
  last_run_at timestamptz,
  check ((lease_owner is null) = (lease_expires_at is null))
);

alter table private.pull_schedule enable row level security;
revoke all on table private.pull_schedule from public, anon, authenticated, service_role;

-- Every user with a source gets a row when the source is added (triggers below; existing
-- users are backfilled here), so claiming only reads and locks rows and two overlapping
-- claims never wait on each other's insert.
create or replace function private.ensure_pull_schedule() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into private.pull_schedule (user_id) values (new.user_id) on conflict (user_id) do nothing;
  return new;
end;
$$;
revoke all on function private.ensure_pull_schedule() from public, anon, authenticated, service_role;

create trigger web_feeds_ensure_pull_schedule after insert on public.web_feeds
  for each row execute function private.ensure_pull_schedule();
create trigger mail_connections_ensure_pull_schedule after insert on public.mail_connections
  for each row execute function private.ensure_pull_schedule();

insert into private.pull_schedule (user_id)
select f.user_id from public.web_feeds f
union
select c.user_id from public.mail_connections c
on conflict (user_id) do nothing;

-- Claims at most one due user for p_owner (a random id per tick) and returns
-- {user_id, due_for, cycle_started_at}, or null when nobody is due. A user is due when:
-- they have at least one switched-on web feed or active mail connection; their latest
-- delivery (user_settings, else 07:00 UTC) minus the lead time has passed; that delivery
-- is later than the one their last completed pull was for; no unexpired lease is held;
-- and no retry time lies ahead. FOR UPDATE SKIP LOCKED plus the lease make two
-- overlapping ticks claim different users, never the same one.
create or replace function public.pull_claim_next(
  p_now timestamptz,
  p_lead_minutes integer,
  p_lease_seconds integer,
  p_owner uuid
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_due timestamptz;
  v_started timestamptz;
begin
  if p_now is null or p_owner is null then
    raise exception 'p_now and p_owner are required' using errcode = '22004';
  end if;
  if p_lead_minutes is null or p_lead_minutes not between 0 and 360 then
    raise exception 'lead must be 0 to 360 minutes' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds not between 30 and 3600 then
    raise exception 'lease must be 30 to 3600 seconds' using errcode = '22023';
  end if;

  select s.user_id, d.due_for into v_user, v_due
  from private.pull_schedule s
  left join public.user_settings us on us.user_id = s.user_id
  cross join lateral (
    select private.delivery_due_at(
      p_now,
      coalesce(us.delivery_time, time '07:00'),
      coalesce(us.timezone, 'UTC'),
      pg_catalog.make_interval(mins => p_lead_minutes)
    ) as due_for
  ) d
  where (exists (select 1 from public.web_feeds f where f.user_id = s.user_id and f.included)
         or exists (select 1 from public.mail_connections c where c.user_id = s.user_id and c.status = 'active'))
    and d.due_for is not null
    and (s.completed_for is null or d.due_for > s.completed_for)
    and (s.lease_expires_at is null or s.lease_expires_at <= p_now)
    and (s.next_retry_at is null or s.next_retry_at <= p_now)
  order by d.due_for, s.user_id
  limit 1
  for update of s skip locked;

  if v_user is null then
    return null;
  end if;

  update private.pull_schedule s
  set cycle_started_at = case when s.cycle_due_for is distinct from v_due then p_now else s.cycle_started_at end,
      cycle_due_for = v_due,
      lease_owner = p_owner,
      lease_expires_at = p_now + pg_catalog.make_interval(secs => p_lease_seconds)
  where s.user_id = v_user
  returning s.cycle_started_at into v_started;

  return jsonb_build_object('user_id', v_user, 'due_for', v_due, 'cycle_started_at', v_started);
end;
$$;

-- Ends a claimed run. Only the lease holder can end it (returns false otherwise).
--   complete: the cycle is done; completed_for moves to it and the failure count resets.
--   partial:  time ran out or a source waits for its retry; the user stays due, from
--             p_retry_at if given (else the next tick).
--   failed:   the run failed as a whole; failure_count + 1 and a backoff of 5 minutes,
--             doubling, at most 1 hour; p_error (a short code) is kept.
create or replace function public.pull_finish(
  p_user_id uuid,
  p_owner uuid,
  p_now timestamptz,
  p_outcome text,
  p_retry_at timestamptz,
  p_error text
) returns boolean
language plpgsql security definer
set search_path = ''
as $$
begin
  if p_outcome is null or p_outcome not in ('complete', 'partial', 'failed') then
    raise exception 'unknown outcome' using errcode = '22023';
  end if;
  if p_error is not null and p_error !~ '^[a-z0-9_+]{1,40}$' then
    raise exception 'error must be a short code' using errcode = '22023';
  end if;

  update private.pull_schedule s
  set completed_for = case when p_outcome = 'complete' then s.cycle_due_for else s.completed_for end,
      failure_count = case when p_outcome = 'failed' then s.failure_count + 1 else 0 end,
      next_retry_at = case
        when p_outcome = 'failed' then p_now + private.retry_backoff(s.failure_count + 1, interval '5 minutes', interval '1 hour')
        when p_outcome = 'partial' then p_retry_at
        else null end,
      last_error = case when p_outcome = 'failed' then coalesce(p_error, 'unknown') else null end,
      last_run_at = p_now,
      lease_owner = null,
      lease_expires_at = null
  where s.user_id = p_user_id and s.lease_owner = p_owner;
  return found;
end;
$$;

revoke all on function public.pull_claim_next(timestamptz, integer, integer, uuid) from public, anon, authenticated;
revoke all on function public.pull_finish(uuid, uuid, timestamptz, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.pull_claim_next(timestamptz, integer, integer, uuid) to service_role;
grant execute on function public.pull_finish(uuid, uuid, timestamptz, text, timestamptz, text) to service_role;

-- ---------------------------------------------------------------------------------------
-- The tick. Reads two Vault secrets by name:
--   impartly_pull_url     the full https URL of the app's pull route
--                         (https://<your Vercel domain>/api/cron/pull)
--   impartly_cron_secret  the same value as the CRON_SECRET env var in Vercel
-- and POSTs to the route with "Authorization: Bearer <secret>". Missing either: a
-- notice and no request. Not https: no request. Returns the pg_net request id, or null.
-- The timeout is a little over the route's 60-second limit. As Supabase documents for
-- this pattern, pg_net keeps the request (headers included) in net.http_request_queue
-- until it is sent, so any role that can log in to the database can read the secret for
-- that moment; the API roles cannot read the net schema.
create or replace function private.cron_pull_tick() returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  select ds.decrypted_secret into v_url from vault.decrypted_secrets ds where ds.name = 'impartly_pull_url';
  select ds.decrypted_secret into v_secret from vault.decrypted_secrets ds where ds.name = 'impartly_cron_secret';
  if v_url is null or v_secret is null or length(v_secret) < 32 then
    raise notice 'impartly scheduled pull: set the impartly_pull_url and impartly_cron_secret Vault secrets (see README)';
    return null;
  end if;
  if v_url !~ '^https://[^/?#@[:space:]]+/' then
    raise notice 'impartly scheduled pull: impartly_pull_url must be an https URL';
    return null;
  end if;
  return net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
    timeout_milliseconds := 65000
  );
end;
$$;

revoke all on function private.cron_pull_tick() from public, anon, authenticated, service_role;

-- Every 5 minutes. The command names no secret; the tick reads them at run time.
select cron.schedule('impartly-scheduled-pull', '*/5 * * * *', 'select private.cron_pull_tick()');
