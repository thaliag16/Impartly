// Listening settings (GOAL.md Phase 2, "Voice, speed and order settings persist per user"):
// the voice with a short preview, the playback speed, and the order of newsletters in the
// briefing. Linked from /settings (beside the delivery time) and from the player's voice and
// speed chips. A page of its own so each screen keeps one watermelon action (GOAL.md 1a).
// Read as the signed-in user under RLS; saving goes through ./actions.ts.

import Link from "next/link";
import { redirect } from "next/navigation";
import { loadListenSettings, orderFeeds, savedOrderFor, type OrderableFeed } from "../../../lib/briefing/settings";
import { createComponentClient, getComponentUser } from "../../../lib/supabase/server";
import { fakeRendererEnabled } from "../../listen/data";
import { saveListeningAction } from "./actions";
import { ListeningForm } from "./listening-form";

export const dynamic = "force-dynamic";

async function loadFeeds(client: NonNullable<Awaited<ReturnType<typeof createComponentClient>>>): Promise<OrderableFeed[] | null> {
  const { data, error } = await client.from("web_feeds").select("id, title, included, created_at").order("created_at", { ascending: true });
  if (error) return null;
  return ((data ?? []) as { id: string; title: string | null; included: boolean | null }[]).map((f) => ({
    id: f.id.toLowerCase(),
    title: f.title?.trim() || "Untitled newsletter",
    included: f.included === true,
  }));
}

export default async function ListeningSettingsPage() {
  const client = await createComponentClient();
  const user = await getComponentUser(client);
  if (!client || !user) redirect("/login?next=%2Fsettings%2Flistening");

  const [settings, feeds] = await Promise.all([loadListenSettings(client), loadFeeds(client)]);

  return (
    <main className="px-page">
      <header className="px-header">
        <Link href="/" className="px-wordmark">
          impartly
        </Link>
        <nav aria-label="Pages" className="px-row">
          <Link href="/settings" className="px-btn px-btn-quiet">
            Delivery time
          </Link>
          <Link href="/listen" className="px-btn px-btn-quiet">
            Listen
          </Link>
        </nav>
      </header>
      <div className="px-field">
        <span className="px-label px-muted">How you listen</span>
        <h1 className="px-h1">Listening</h1>
        <p className="px-body">Pick the voice and speed of your briefing, and the order your newsletters play in.</p>
      </div>
      {settings && feeds ? (
        <ListeningForm
          initial={{ voice: settings.voice, speed: settings.speed, feedOrder: savedOrderFor(feeds, settings.feedOrder) }}
          feeds={orderFeeds(feeds, settings.feedOrder)}
          fakeRenderer={fakeRendererEnabled()}
          save={saveListeningAction}
        />
      ) : (
        <p className="px-alert" role="alert">
          Could not load your settings. Reload the page to try again.
        </p>
      )}
    </main>
  );
}
