-- Phase 2 (Listen): the render cost log (GOAL.md Phase 2, "Render cost per briefing logged
-- and within budget"). One row per render of a briefing on the listener's device: what was
-- rendered, how long it took and how much audio it made. The budget it is checked against
-- is in lib/briefing/render-budget.ts.
--
-- Who writes it: the signed-in user's own client, under RLS (lib/briefing/render-log.ts,
-- through the /listen server action). Chosen over a server-side function because:
--   * the numbers come from the user's own device either way; a function would not make
--     them more trustworthy, only add a second write path to secure;
--   * a security definer function bypasses RLS and would need its own auth.uid() checks,
--     while a plain insert stays inside the policy the generic RLS tests already exercise;
--   * nothing here touches another user's data or a server-only table.
-- What keeps it honest anyway:
--   * insert only, on named columns: user_id defaults to auth.uid() and the policy refuses
--     any other value; id and created_at are not insertable, so rows cannot be backdated;
--   * no update or delete for users (append-only); deleting the account deletes the rows;
--   * every value bounded by a check (finite, non-negative, at most four hours, counts
--     that add up, a known voice, speed and device class);
--   * a flood guard: at most 100 rows per user in any 24 hours (a briefing renders once,
--     or again after a voice or speed change; all-cached opens are not logged).
-- Privacy: counts and timings only, and a coarse device class. No user agent string, no IP
-- address, no screen size, no sentence text.

create table public.render_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- The briefing: its delivery time (lib/briefing/load.ts, deliveryAt).
  delivery_at timestamptz not null,
  voice text not null check (voice in ('af_heart', 'bm_daniel')),
  speed numeric(3, 2) not null check (speed between 0.50 and 2.00),
  chars integer not null check (chars between 0 and 2000000),
  sentences integer not null check (sentences between 1 and 10000),
  rendered integer not null check (rendered >= 1),
  cached integer not null check (cached >= 0),
  -- Seconds. NaN sorts above every number in Postgres and Infinity is above the limit, so
  -- "between 0 and 14400" refuses both.
  audio_seconds double precision not null check (audio_seconds between 0 and 14400),
  rendered_audio_seconds double precision not null check (rendered_audio_seconds between 0 and 14400),
  render_seconds double precision not null check (render_seconds between 0 and 14400),
  device_class text not null check (device_class in ('mobile', 'desktop', 'unknown')),
  created_at timestamptz not null default now(),
  check (rendered + cached = sentences),
  check (rendered_audio_seconds <= audio_seconds)
);

create index render_log_user_delivery_idx on public.render_log (user_id, delivery_at desc);
create index render_log_user_created_idx on public.render_log (user_id, created_at desc);

alter table public.render_log enable row level security;
revoke all on table public.render_log from anon, authenticated;
grant select on table public.render_log to authenticated;
grant insert (
  user_id, delivery_at, voice, speed, chars, sentences, rendered, cached,
  audio_seconds, rendered_audio_seconds, render_seconds, device_class
) on table public.render_log to authenticated;

create policy "render_log: read own" on public.render_log
  for select to authenticated using (user_id = (select auth.uid()));

create policy "render_log: insert own" on public.render_log
  for insert to authenticated with check (user_id = (select auth.uid()));

-- The flood guard. Runs as the inserting user (security invoker), so it counts the rows
-- that user can see: their own.
create function private.render_log_rate_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (
    select count(*) from public.render_log
    where user_id = new.user_id and created_at > now() - interval '24 hours'
  ) >= 100 then
    raise exception 'render log limit reached: at most 100 renders a day'
      using errcode = '53400';
  end if;
  return new;
end;
$$;

revoke all on function private.render_log_rate_guard() from public;
grant execute on function private.render_log_rate_guard() to authenticated, service_role;

create trigger render_log_rate_guard
  before insert on public.render_log
  for each row execute function private.render_log_rate_guard();
