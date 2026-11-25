// Settings: when the briefing is ready (delivery time, every 15 minutes) and in which time
// zone. The row is read as the signed-in user under RLS; saving goes through the server
// action in ./actions.ts. Voice, speed and newsletter order are on their own linked page
// (./listening), so each screen keeps one watermelon action.

import Link from "next/link";
import { redirect } from "next/navigation";
import { timezoneOptions } from "../../lib/schedule/delivery";
import { loadDeliverySettings } from "../../lib/schedule/settings";
import { createComponentClient, getComponentUser } from "../../lib/supabase/server";
import { saveDeliveryAction } from "./actions";
import { DeliveryForm } from "./delivery-form";
import { nextBriefingFor } from "./next";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const client = await createComponentClient();
  const user = await getComponentUser(client);
  if (!client || !user) redirect("/login?next=%2Fsettings");

  const settings = await loadDeliverySettings(client);
  const next = settings ? await nextBriefingFor(settings) : null;

  return (
    <main className="px-page">
      <header className="px-header">
        <Link href="/" className="px-wordmark">
          impartly
        </Link>
        <nav aria-label="Pages" className="px-row">
          <Link href="/newsletters" className="px-btn px-btn-quiet">
            Newsletters
          </Link>
          <form method="post" action="/auth/sign-out">
            <button type="submit" className="px-btn px-btn-quiet">
              Sign out
            </button>
          </form>
        </nav>
      </header>
      <div className="px-field">
        <span className="px-label px-muted">When you listen</span>
        <h1 className="px-h1">Delivery time</h1>
        <p className="px-body">
          Pick when your briefing should be ready. Impartly starts pulling your newsletters a little before then.
        </p>
      </div>
      {settings ? (
        <DeliveryForm
          initial={settings}
          initialNext={next}
          timezones={timezoneOptions([settings.timezone])}
          save={saveDeliveryAction}
        />
      ) : (
        <p className="px-alert" role="alert">
          Could not load your settings. Reload the page to try again.
        </p>
      )}
      <section className="px-card" aria-labelledby="listening-heading">
        <h2 id="listening-heading" className="px-label">
          How you listen
        </h2>
        <p className="px-body">The voice, its speed, and the order your newsletters play in.</p>
        <div className="px-row">
          <Link href="/settings/listening" className="px-btn">
            Voice, speed and order
          </Link>
        </div>
      </section>
    </main>
  );
}
