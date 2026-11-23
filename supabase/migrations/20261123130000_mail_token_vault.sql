-- Mail connection tokens in Supabase Vault.
--
-- OAuth tokens never sit in a table column. These functions are the only way the server
-- stores, reads, rotates and removes them (lib/mail/token-store.ts calls them):
--   * mail_connection_save: creates the Vault secret with vault.create_secret and the
--     mail_connections row that holds only its id (or, for a reconnect, replaces the
--     secret's value and marks the connection active again)
--   * mail_connection_tokens: reads the decrypted tokens
--   * mail_connection_update_tokens: replaces them after a refresh
--   * mail_connection_remove: deletes the connection row
-- A trigger deletes the Vault secret whenever a mail_connections row is deleted, so the
-- secret also goes when the row is removed by a cascade (for example, deleting the user).
--
-- Only service_role may execute these functions: they are revoked from public, anon and
-- authenticated (tested in tests/db/vault-tokens.test.ts). They run as their owner
-- (security definer) with an empty search_path, so every name is schema-qualified.
--
-- Vault (the supabase_vault extension) is installed on every Supabase project. The tests
-- run against a stand-in in tests/db/supabase-shim.sql.

create or replace function private.mail_connection_delete_secret() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  delete from vault.secrets where id = old.token_secret_id;
  return old;
end;
$$;
revoke all on function private.mail_connection_delete_secret() from public;

create trigger mail_connections_delete_secret
  after delete on public.mail_connections
  for each row execute function private.mail_connection_delete_secret();

-- ---------------------------------------------------------------------------------------
create or replace function public.mail_connection_save(
  p_user_id uuid,
  p_provider text,
  p_account_address text,
  p_tokens text
) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_secret uuid;
begin
  if p_tokens is null or length(p_tokens) = 0 then
    raise exception 'tokens are required';
  end if;

  select c.id, c.token_secret_id into v_id, v_secret
  from public.mail_connections c
  where c.user_id = p_user_id
    and c.provider = p_provider
    and c.account_address = lower(p_account_address)
  for update;

  if v_id is null then
    v_id := gen_random_uuid();
    v_secret := vault.create_secret(
      p_tokens,
      'mail_connection:' || v_id::text,
      'OAuth tokens for one Impartly mail connection'
    );
    insert into public.mail_connections (id, user_id, provider, account_address, token_secret_id)
    values (v_id, p_user_id, p_provider, lower(p_account_address), v_secret);
  else
    perform vault.update_secret(v_secret, p_tokens);
    update public.mail_connections set status = 'active' where id = v_id;
  end if;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------------------
create or replace function public.mail_connection_tokens(p_connection_id uuid) returns text
language sql stable security definer
set search_path = ''
as $$
  select s.decrypted_secret
  from public.mail_connections c
  join vault.decrypted_secrets s on s.id = c.token_secret_id
  where c.id = p_connection_id
$$;

-- ---------------------------------------------------------------------------------------
create or replace function public.mail_connection_update_tokens(
  p_connection_id uuid,
  p_tokens text
) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_secret uuid;
begin
  if p_tokens is null or length(p_tokens) = 0 then
    raise exception 'tokens are required';
  end if;
  select c.token_secret_id into v_secret from public.mail_connections c where c.id = p_connection_id;
  if v_secret is null then
    raise exception 'no such mail connection' using errcode = 'P0002';
  end if;
  perform vault.update_secret(v_secret, p_tokens);
end;
$$;

-- ---------------------------------------------------------------------------------------
create or replace function public.mail_connection_remove(p_connection_id uuid) returns void
language sql security definer
set search_path = ''
as $$
  -- The mail_connections_delete_secret trigger deletes the Vault secret.
  delete from public.mail_connections where id = p_connection_id
$$;

-- ---------------------------------------------------------------------------------------
-- Server only.
revoke all on function public.mail_connection_save(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.mail_connection_tokens(uuid) from public, anon, authenticated;
revoke all on function public.mail_connection_update_tokens(uuid, text) from public, anon, authenticated;
revoke all on function public.mail_connection_remove(uuid) from public, anon, authenticated;
grant execute on function public.mail_connection_save(uuid, text, text, text) to service_role;
grant execute on function public.mail_connection_tokens(uuid) to service_role;
grant execute on function public.mail_connection_update_tokens(uuid, text) to service_role;
grant execute on function public.mail_connection_remove(uuid) to service_role;
