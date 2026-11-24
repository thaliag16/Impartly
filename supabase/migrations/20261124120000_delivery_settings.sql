-- Delivery time and timezone settings (GOAL.md Phase 1: "Scheduled pull runs at a
-- user-set time"). The settings screen (/settings) writes the user's own user_settings
-- row under RLS, as before. This migration adds:
--
--   * public.delivery_next_after: the next delivery instant after a given moment for a
--     time and zone, using the same schedule math as the scheduled pull
--     (private.local_to_instant), so the screen's "Your next briefing" is the moment the
--     pull aims for, daylight saving included. Pure math, no table read.
--   * a trigger on user_settings that resets the user's pull schedule when the delivery
--     time or timezone changes, however the row is written (the screen, the API under
--     RLS, or Supabase's Table Editor). The rule: a change never makes a delivery that is
--     already in the past due. If the user's last delivery under the old settings was
--     already pulled, the latest delivery under the new settings that is at or before now
--     counts as done too, so the next pull is for the next delivery at the new time (its
--     lead time still applies). If a pull under the old settings was still owed, it
--     stays owed and is made for the new time. A user who has never had a pull keeps
--     getting their first pull at once. A pull waiting only on a source's retry time
--     (no failures of its own) is released; a failure's backoff is kept. Leases are not
--     touched: a tick working on the user finishes normally. (It cannot move
--     completed_for backwards: when nothing was owed, the reset only raises completed_for
--     to a delivery at or before now, and a leased cycle is for a later one.)
--
-- Access: delivery_next_after is callable by the server only; the reset
-- function and the clock are callable by no API role. Tested in
-- tests/db/delivery-settings.test.ts.

-- ---------------------------------------------------------------------------------------
-- The trigger's clock. Tests pin it with `set impartly.now = '<timestamptz>'`; the app
-- never sets it, so in production it is the statement's start time.
create or replace function private.settings_clock() returns timestamptz
language sql stable
set search_path = ''
as $$
  select coalesce(nullif(pg_catalog.current_setting('impartly.now', true), '')::timestamptz,
                  pg_catalog.statement_timestamp())
$$;
revoke all on function private.settings_clock() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------
-- The next delivery strictly after p_after, at p_time local in p_tz. Deliveries are one
-- per local date (private.local_to_instant handles skipped and repeated hours). Raises
-- 22023 for a zone Postgres does not know.
create or replace function public.delivery_next_after(p_after timestamptz, p_time time, p_tz text)
returns timestamptz
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_next timestamptz;
begin
  if p_after is null or p_time is null or p_tz is null then
    raise exception 'p_after, p_time and p_tz are required' using errcode = '22004';
  end if;
  if not private.is_valid_timezone(p_tz) then
    raise exception 'unknown time zone' using errcode = '22023';
  end if;
  select min(d.at) into v_next
  from pg_catalog.generate_series(-1, 2) as g(days)
  cross join lateral (
    select private.local_to_instant(((p_after at time zone p_tz)::date + g.days) + p_time, p_tz) as at
  ) d
  where d.at > p_after;
  return v_next;
end;
$$;

-- Server only, like every public function (tests/db/vault-tokens.test.ts): the settings
-- page calls it through the service-role client with the signed-in user's saved values.
revoke all on function public.delivery_next_after(timestamptz, time, text) from public, anon, authenticated;
grant execute on function public.delivery_next_after(timestamptz, time, text) to service_role;

-- ---------------------------------------------------------------------------------------
-- The reset (rule in the header). Lead 0: "at or before p_now", so a delivery still in the
-- future, even inside its lead time, is never skipped.
create or replace function private.pull_schedule_settings_changed(
  p_user_id uuid,
  p_old_time time,
  p_old_tz text,
  p_new_time time,
  p_new_tz text,
  p_now timestamptz
) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old_latest timestamptz := private.delivery_due_at(p_now, p_old_time, p_old_tz, interval '0');
  v_new_latest timestamptz := private.delivery_due_at(p_now, p_new_time, p_new_tz, interval '0');
begin
  update private.pull_schedule s
  set completed_for = case
        when s.completed_for is not null and (v_old_latest is null or s.completed_for >= v_old_latest)
          then greatest(s.completed_for, v_new_latest)
        else s.completed_for end,
      next_retry_at = case when s.failure_count = 0 then null else s.next_retry_at end
  where s.user_id = p_user_id;
end;
$$;
revoke all on function private.pull_schedule_settings_changed(uuid, time, text, time, text, timestamptz)
  from public, anon, authenticated, service_role;

-- On insert the old settings are the defaults the schedule used without a row (07:00 UTC,
-- as in pull_claim_next). Nothing happens when neither field changed.
create or replace function private.user_settings_delivery_changed() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old_time time := case when tg_op = 'INSERT' then time '07:00' else old.delivery_time end;
  v_old_tz text := case when tg_op = 'INSERT' then 'UTC' else old.timezone end;
begin
  if v_old_time is distinct from new.delivery_time or v_old_tz is distinct from new.timezone then
    perform private.pull_schedule_settings_changed(
      new.user_id, v_old_time, v_old_tz, new.delivery_time, new.timezone, private.settings_clock());
  end if;
  return null;
end;
$$;
revoke all on function private.user_settings_delivery_changed() from public, anon, authenticated, service_role;

create trigger user_settings_delivery_changed
  after insert or update of delivery_time, timezone on public.user_settings
  for each row execute function private.user_settings_delivery_changed();
