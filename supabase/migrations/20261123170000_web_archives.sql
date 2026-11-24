-- Public web archives: newsletters with no RSS or Atom feed, read from their public
-- archive (index) page (GOAL.md Phase 1, "else its public web archive";
-- lib/sources/web/archive-source.ts). No new table.
--
--   * web_feeds.feed_format gains 'archive': feed_url is then the archive page the server
--     found to list issues. As before, only the server stores it (feeds_subscribe,
--     service_role only), after discovery checked it.
--   * pipeline_load returns each feed's format and, for archives, the item keys and links
--     of the 50 newest stored issues, so the archive source fetches only new issue pages.

alter table public.web_feeds drop constraint web_feeds_feed_format_check;
alter table public.web_feeds
  add constraint web_feeds_feed_format_check check (feed_format in ('rss', 'atom', 'archive'));

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

revoke all on function public.pipeline_load(uuid) from public, anon, authenticated;
grant execute on function public.pipeline_load(uuid) to service_role;
