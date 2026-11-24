// The newsletter picker: find a newsletter by name (the catalog) or by its website or feed
// address, see what Impartly found, add it, and switch each one on or off or remove it.
// The list is read as the signed-in user under RLS; every change goes through the server
// actions in ./actions.ts.

import Link from "next/link";
import { redirect } from "next/navigation";
import { catalogPicks } from "../../lib/feeds/picker";
import type { FeedRow } from "../../lib/feeds/types";
import { loadCatalog } from "../../lib/sources/web/catalog";
import { createComponentClient, getComponentUser } from "../../lib/supabase/server";
import { addAction, previewAction, removeAction, setIncludedAction } from "./actions";
import { Picker } from "./picker";

export const dynamic = "force-dynamic";

export default async function NewslettersPage() {
  const client = await createComponentClient();
  const user = await getComponentUser(client);
  if (!client || !user) redirect("/login?next=%2Fnewsletters");

  const { data, error } = await client
    .from("web_feeds")
    .select("id, title, homepage_url, feed_url, included, last_fetched_at, last_error")
    .order("created_at");
  const feeds = (data ?? []) as FeedRow[];

  return (
    <main className="px-page">
      <header className="px-header">
        <Link href="/" className="px-wordmark">
          impartly
        </Link>
        <form method="post" action="/auth/sign-out">
          <button type="submit" className="px-btn px-btn-quiet">
            Sign out
          </button>
        </form>
      </header>
      <div className="px-field">
        <span className="px-label px-muted">Pick what you hear</span>
        <h1 className="px-h1">Newsletters</h1>
        <p className="px-body">
          Search by name, or paste a newsletter&apos;s website or feed address. Impartly reads its public feed,
          respects robots.txt and never gets around a paywall.
        </p>
      </div>
      <Picker
        feeds={feeds}
        listUnavailable={!!error}
        catalog={catalogPicks(loadCatalog())}
        actions={{ preview: previewAction, add: addAction, setIncluded: setIncludedAction, remove: removeAction }}
      />
    </main>
  );
}
