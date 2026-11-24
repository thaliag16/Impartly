-- Phase 2 (Listen): the briefing loader's window.
--
-- The briefing is the user's summaries of the issues stored for their latest delivery:
-- the latest delivery whose pull has started (delivery minus the lead, PULL_LEAD_MINUTES)
-- and every issue stored from that pull's start on. lib/briefing/load.ts reads the rows
-- themselves with the user's own client, under RLS (newsletters, summaries, web_feeds,
-- user_settings, all already readable by their owner). Only the date math is here,
-- because it lives in the private schema with the scheduled pull:
--
--   public.delivery_due_at(p_now, p_time, p_tz, p_lead_minutes): the latest delivery
--   instant D (p_time local in p_tz, one per local date, daylight saving handled by
--   private.local_to_instant) with D - lead <= p_now. A thin wrapper around
--   private.delivery_due_at, the function the scheduled pull itself uses, so the briefing
--   and the pull always agree on which delivery is current. Raises 22023 for a zone
--   Postgres does not know.
--
-- Access: server only (service_role), like public.delivery_next_after. It takes no user
-- id and reads no table. Every function in public stays closed to anon and authenticated
-- (tests/db/vault-tokens.test.ts). Tested in tests/db/briefing-loader.test.ts.

create or replace function public.delivery_due_at(
  p_now timestamptz,
  p_time time,
  p_tz text,
  p_lead_minutes integer
)
returns timestamptz
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if p_now is null or p_time is null or p_tz is null or not private.is_valid_timezone(p_tz) then
    raise exception 'invalid delivery settings' using errcode = '22023';
  end if;
  if p_lead_minutes is null or p_lead_minutes < 0 or p_lead_minutes > 360 then
    raise exception 'lead must be 0 to 360 minutes' using errcode = '22023';
  end if;
  return private.delivery_due_at(p_now, p_time, p_tz, make_interval(mins => p_lead_minutes));
end
$$;

revoke all on function public.delivery_due_at(timestamptz, time, text, integer) from public, anon, authenticated;
grant execute on function public.delivery_due_at(timestamptz, time, text, integer) to service_role;
