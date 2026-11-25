-- Summary cost (run 27, Thalia 2026-11-24: "make sure that the summaries are cost optimized
-- so that I spend as little as possible"). Three things, all server-only functions plus one
-- table:
--
-- 1. public.summary_usage: what each summary request cost, as the summary endpoint reported
--    it (tokens and the provider's cost, no text of any kind). One row per summary the
--    model was asked for; none for a summary copied from an identical issue (that one cost
--    nothing). Written only by the server (pipeline_record_usage); the user reads their own
--    rows under RLS. This is the run-26 open question, option (b): the render budget check
--    (lib/briefing/render-budget.ts) reads real numbers from here instead of projecting
--    them from eval runs. `delivery_at` is the delivery the scheduled pull was for (the
--    same instant the briefing loader and render_log use), null for a run outside the
--    schedule. Deleting the issue keeps the cost row (newsletter_id becomes null): the
--    money was spent either way.
--
-- 2. public.pipeline_pending_summaries, replaced: never asks for a summary that will not be
--    played. It now leaves out issues from a switched-off web feed (the briefing loader
--    skips them, lib/briefing/load.ts), and takes p_stored_since: issues stored before the
--    current briefing's window (created_at, as the loader reads it) are no longer
--    summarized by a scheduled pull, because no briefing would play them.
--
-- 3. public.pipeline_reuse_summaries: never pays twice for the same text. An issue whose
--    body is identical (case and white space aside) to one the user already has a summary
--    of at the same length, from the last 7 days, gets a copy of that summary instead of a
--    model call (the same issue syndicated to two feeds, or a feed and its archive).
--
-- Tested in tests/db/summary-cost.test.ts and tests/db/rls.test.ts.

create table public.summary_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  newsletter_id uuid,
  delivery_at timestamptz,
  length text not null check (length in ('headline', 'brief', 'deep')),
  model text not null check (char_length(model) between 1 and 200),
  requests smallint not null check (requests between 1 and 10),
  prompt_units integer not null check (prompt_units between 0 and 10000000),
  completion_units integer not null check (completion_units between 0 and 10000000),
  reasoning_units integer not null check (reasoning_units between 0 and 10000000),
  thinking boolean not null,
  -- The *_units columns are token counts as the endpoint reports them (named "units"
  -- because no public column may be named like a credential: tests/db/rls.test.ts).
  -- In the endpoint's billing unit (US dollars on OpenRouter); null when not reported.
  -- NaN and Infinity are refused by the range check.
  cost_usd numeric(14, 10) check (cost_usd is null or cost_usd between 0 and 100),
  created_at timestamptz not null default now(),
  -- The issue must belong to the same user; deleting it keeps the cost.
  foreign key (newsletter_id, user_id)
    references public.newsletters (id, user_id) on delete set null (newsletter_id)
);

create index summary_usage_user_created_idx on public.summary_usage (user_id, created_at desc);
create index summary_usage_user_delivery_idx on public.summary_usage (user_id, delivery_at);

alter table public.summary_usage enable row level security;
revoke all on table public.summary_usage from anon, authenticated;
grant select on table public.summary_usage to authenticated;

create policy "summary_usage: read own" on public.summary_usage
  for select to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------------------
-- Records one summary's usage. Server only.
create or replace function public.pipeline_record_usage(
  p_user_id uuid,
  p_newsletter_id uuid,
  p_delivery_at timestamptz,
  p_length text,
  p_model text,
  p_requests integer,
  p_prompt_tokens integer,
  p_completion_tokens integer,
  p_reasoning_tokens integer,
  p_thinking boolean,
  p_cost_usd numeric
) returns void
language sql security definer
set search_path = ''
as $$
  insert into public.summary_usage (
    user_id, newsletter_id, delivery_at, length, model, requests, prompt_units,
    completion_units, reasoning_units, thinking, cost_usd
  ) values (
    p_user_id, p_newsletter_id, p_delivery_at, p_length, left(p_model, 200), p_requests,
    p_prompt_tokens, p_completion_tokens, p_reasoning_tokens, p_thinking, p_cost_usd
  )
$$;

-- ---------------------------------------------------------------------------------------
-- The issues a summary may be asked for: the user's, received since p_since, stored since
-- p_stored_since (when given), not from a switched-off web feed, with no summary at
-- p_length yet. Shared by the two functions below.
create or replace function private.pending_issues(
  p_user_id uuid,
  p_length text,
  p_since timestamptz,
  p_stored_since timestamptz
) returns setof public.newsletters
language sql stable
set search_path = ''
as $$
  select n.*
  from public.newsletters n
  where n.user_id = p_user_id
    and n.received_at >= p_since
    and (p_stored_since is null or n.created_at >= p_stored_since)
    and (
      n.feed_id is null
      or exists (select 1 from public.web_feeds f where f.id = n.feed_id and f.included)
    )
    and not exists (
      select 1 from public.summaries s where s.newsletter_id = n.id and s.length = p_length
    )
$$;

revoke all on function private.pending_issues(uuid, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function private.pending_issues(uuid, text, timestamptz, timestamptz) to service_role;

-- The text a duplicate is recognised by: case and runs of white space do not count.
create or replace function private.body_key(p_body text) returns text
language sql immutable
set search_path = ''
as $$
  select md5(regexp_replace(lower(btrim(p_body)), '\s+', ' ', 'g'))
$$;

revoke all on function private.body_key(text) from public, anon, authenticated;
grant execute on function private.body_key(text) to service_role;

-- ---------------------------------------------------------------------------------------
-- Replaces the four-argument version (one name, one signature: a second overload would
-- make calls with named arguments ambiguous).
drop function public.pipeline_pending_summaries(uuid, text, timestamptz, integer);

create function public.pipeline_pending_summaries(
  p_user_id uuid,
  p_length text,
  p_since timestamptz,
  p_limit integer,
  p_stored_since timestamptz default null
) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.received_at desc), '[]'::jsonb)
  from (
    select n.id, n.sender_address, n.sender_name, n.subject, n.received_at, n.body_text
    from private.pending_issues(p_user_id, p_length, p_since, p_stored_since) n
    order by n.received_at desc
    limit greatest(0, least(p_limit, 500))
  ) t
$$;

-- ---------------------------------------------------------------------------------------
-- Copies a summary to each pending issue whose body matches an issue of the same user
-- already summarized at p_length in the last 7 days. Returns how many were copied.
create or replace function public.pipeline_reuse_summaries(
  p_user_id uuid,
  p_length text,
  p_since timestamptz,
  p_stored_since timestamptz default null
) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with pending as (
    select p.id, private.body_key(p.body_text) as k
    from private.pending_issues(p_user_id, p_length, p_since, p_stored_since) p
  ),
  done as (
    select distinct on (private.body_key(n.body_text))
      private.body_key(n.body_text) as k, s.summary_text
    from public.summaries s
    join public.newsletters n on n.id = s.newsletter_id and n.user_id = p_user_id
    where s.user_id = p_user_id
      and s.length = p_length
      and s.created_at >= now() - interval '7 days'
    order by private.body_key(n.body_text), s.created_at desc
  ),
  ins as (
    insert into public.summaries (user_id, newsletter_id, length, summary_text)
    select p_user_id, pending.id, p_length, done.summary_text
    from pending join done using (k)
    on conflict (newsletter_id, length) do nothing
    returning 1
  )
  select count(*) into v_count from ins;
  return v_count;
end;
$$;

revoke all on function public.pipeline_record_usage(uuid, uuid, timestamptz, text, text, integer, integer, integer, integer, boolean, numeric) from public, anon, authenticated;
revoke all on function public.pipeline_pending_summaries(uuid, text, timestamptz, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.pipeline_reuse_summaries(uuid, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.pipeline_record_usage(uuid, uuid, timestamptz, text, text, integer, integer, integer, integer, boolean, numeric) to service_role;
grant execute on function public.pipeline_pending_summaries(uuid, text, timestamptz, integer, timestamptz) to service_role;
grant execute on function public.pipeline_reuse_summaries(uuid, text, timestamptz, timestamptz) to service_role;
