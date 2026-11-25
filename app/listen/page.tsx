// The player (GOAL.md Phase 2): the latest briefing as one queue, with the lock-screen
// controls. The look follows the Player mockup (GOAL.md 1a). The server loads the script
// and the user's voice and speed; the browser renders any missing audio ahead (Kokoro in a
// worker, stored in Cache Storage) and plays it (./player-view.tsx).

import { redirect } from "next/navigation";
import { createComponentClient, getComponentUser } from "../../lib/supabase/server";
import { logRenderAction } from "./actions";
import { fakeRendererEnabled, loadListenData } from "./data";
import { PlayerView } from "./player-view";

export const dynamic = "force-dynamic";

export default async function ListenPage() {
  const client = await createComponentClient();
  const user = await getComponentUser(client);
  if (!client || !user) redirect("/login?next=%2Flisten");

  const data = await loadListenData(client);
  if (!data) {
    return (
      <main className="px-page">
        <h1 className="px-h1">Now playing</h1>
        <p className="px-alert" role="alert">
          Could not load your briefing. Reload the page to try again.
        </p>
      </main>
    );
  }
  return (
    <PlayerView
      script={data.script}
      voice={data.voice}
      speed={data.speed}
      deliveryAt={data.deliveryAt}
      fakeRenderer={fakeRendererEnabled()}
      logRender={logRenderAction}
    />
  );
}
