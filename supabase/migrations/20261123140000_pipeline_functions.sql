-- Pipeline functions: what the server's pull-and-summarize job (lib/pipeline/) reads and
-- writes for ONE user per call.
--
-- Why functions and not table queries from the server: every function takes the user id
-- and only ever reads or writes that user's rows, so the scoping lives in one reviewed
-- place in SQL and is tested on real Postgres (tests/db/pipeline.test.ts). The composite
-- foreign keys from the core migration add a second guard: a newsletter cannot point at
-- another user's connection, and a summary cannot point at another user's newsletter.
--
-- Idempotent: newsletters are unique per (connection_id, provider_message_id) and
-- summaries per (newsletter_id, length); both inserts are "on conflict do nothing", so a
-- re-run never duplicates rows.
--
-- Only service_role may execute these (revoked from public, anon and authenticated; the
-- test in tests/db/vault-tokens.test.ts fails if any public function is executable by
-- anon or authenticated). No new table.

-- ---------------------------------------------------------------------------------------
-- Settings (with defaults when the user has no row yet), sources and connections.
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
      from public.mail_connections c where c.user_id = p_user_id), '[]'::jsonb)
  )
$$;

-- ---------------------------------------------------------------------------------------
-- Stores one newsletter. Returns {"id": ..., "inserted": true|false}; an already stored
-- message (same connection and provider message id) is not stored again.
create or replace function public.pipeline_save_newsletter(
  p_user_id uuid,
  p_connection_id uuid,
  p_provider_message_id text,
  p_sender_address text,
  p_sender_name text,
  p_subject text,
  p_received_at timestamptz,
  p_body_text text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.newsletters
    (user_id, connection_id, provider_message_id, sender_address, sender_name, subject, received_at, body_text)
  values
    (p_user_id, p_connection_id, p_provider_message_id, lower(p_sender_address),
     left(p_sender_name, 200), coalesce(left(p_subject, 500), ''), p_received_at, p_body_text)
  on conflict (connection_id, provider_message_id) do nothing
  returning id into v_id;

  if v_id is not null then
    return jsonb_build_object('id', v_id, 'inserted', true);
  end if;

  select n.id into v_id from public.newsletters n
  where n.connection_id = p_connection_id
    and n.provider_message_id = p_provider_message_id
    and n.user_id = p_user_id;
  if v_id is null then
    raise exception 'newsletter conflict outside this user' using errcode = 'P0002';
  end if;
  return jsonb_build_object('id', v_id, 'inserted', false);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Adds newly seen newsletter senders ([{"address": ..., "name": ...}]) to the user's
-- newsletter_sources with the table's default for `included`. Existing rows are left as
-- they are (a switched-off sender stays off). Returns how many rows were added.
create or replace function public.pipeline_add_sources(p_user_id uuid, p_senders jsonb) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into public.newsletter_sources (user_id, sender_address, display_name)
  select distinct on (lower(s.value ->> 'address'))
         p_user_id, lower(s.value ->> 'address'), left(nullif(s.value ->> 'name', ''), 200)
  from jsonb_array_elements(coalesce(p_senders, '[]'::jsonb)) s
  where length(s.value ->> 'address') between 3 and 320
  on conflict (user_id, sender_address) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- The user's newsletters received since p_since that have no summary at p_length yet,
-- newest first, at most p_limit.
create or replace function public.pipeline_pending_summaries(
  p_user_id uuid,
  p_length text,
  p_since timestamptz,
  p_limit integer
) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.received_at desc), '[]'::jsonb)
  from (
    select n.id, n.sender_address, n.sender_name, n.subject, n.received_at, n.body_text
    from public.newsletters n
    where n.user_id = p_user_id
      and n.received_at >= p_since
      and not exists (
        select 1 from public.summaries s where s.newsletter_id = n.id and s.length = p_length
      )
    order by n.received_at desc
    limit greatest(0, least(p_limit, 500))
  ) t
$$;

-- ---------------------------------------------------------------------------------------
-- Stores one summary; returns true if it was new.
create or replace function public.pipeline_save_summary(
  p_user_id uuid,
  p_newsletter_id uuid,
  p_length text,
  p_summary_text text
) returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.summaries (user_id, newsletter_id, length, summary_text)
  values (p_user_id, p_newsletter_id, p_length, p_summary_text)
  on conflict (newsletter_id, length) do nothing
  returning id into v_id;
  return v_id is not null;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Marks a connection after a pull: status 'error' when the mailbox refused the grant (the
-- user must reconnect), and/or the new last_synced_at. Only the user's own connection.
create or replace function public.pipeline_mark_connection(
  p_user_id uuid,
  p_connection_id uuid,
  p_status text,
  p_synced_at timestamptz
) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if p_status is not null and p_status not in ('active', 'error') then
    raise exception 'invalid status';
  end if;
  update public.mail_connections c
  set status = coalesce(p_status, c.status),
      last_synced_at = coalesce(p_synced_at, c.last_synced_at)
  where c.id = p_connection_id and c.user_id = p_user_id;
  if not found then
    raise exception 'no such mail connection for this user' using errcode = 'P0002';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Server only.
revoke all on function public.pipeline_load(uuid) from public, anon, authenticated;
revoke all on function public.pipeline_save_newsletter(uuid, uuid, text, text, text, text, timestamptz, text) from public, anon, authenticated;
revoke all on function public.pipeline_add_sources(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.pipeline_pending_summaries(uuid, text, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.pipeline_save_summary(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.pipeline_mark_connection(uuid, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.pipeline_load(uuid) to service_role;
grant execute on function public.pipeline_save_newsletter(uuid, uuid, text, text, text, text, timestamptz, text) to service_role;
grant execute on function public.pipeline_add_sources(uuid, jsonb) to service_role;
grant execute on function public.pipeline_pending_summaries(uuid, text, timestamptz, integer) to service_role;
grant execute on function public.pipeline_save_summary(uuid, uuid, text, text) to service_role;
grant execute on function public.pipeline_mark_connection(uuid, uuid, text, timestamptz) to service_role;
