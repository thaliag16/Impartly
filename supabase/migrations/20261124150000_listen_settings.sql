-- Phase 2 (Listen): the order of newsletters in the briefing, per user.
--
-- Voice and speed already live in public.user_settings (20261123120000_phase1_core_tables.sql:
-- voice in ('af_heart', 'bm_daniel'), speed 0.50 to 2.00), readable and writable by the
-- signed-in user for their own row only. This adds the third listening setting:
--
--   feed_order: the user's web feed ids, in the order the briefing reads them. Feeds not
--   in the list follow, newest issue first (lib/briefing/script.ts). Kept in the user's
--   own settings row so it needs no new table and no new policy: the existing "update
--   own" policy and a column grant cover it.
--
-- Ids are not foreign keys (an array cannot be). A removed feed's id is ignored by the
-- briefing and dropped by the next save (lib/briefing/settings.ts); the server-side
-- validation also refuses ids that are not one of the user's own feeds.

alter table public.user_settings
  add column feed_order uuid[] not null default '{}'
    check (cardinality(feed_order) <= 200 and array_position(feed_order, null) is null);

grant update (feed_order) on table public.user_settings to authenticated;
