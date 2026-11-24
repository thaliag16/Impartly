import "server-only";

// What /listen needs from the server: the signed-in user's latest briefing as a script
// (lib/briefing/load.ts, their own rows under RLS), and their voice and speed
// (lib/briefing/settings.ts). The delivery window's date math is the scheduled pull's own
// SQL, reached through the server-only RPC.

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadLatestBriefing, scriptFor } from "../../lib/briefing/load";
import type { BriefingScript } from "../../lib/briefing/script";
import { DEFAULT_LISTEN_SETTINGS, loadListenSettings } from "../../lib/briefing/settings";
import { leadMinutesFromEnv } from "../../lib/schedule/budget";
import type { BriefingVoice } from "../../lib/speech/pins";
import { adminRpc, createAdminClient } from "../../lib/supabase/admin";

export interface ListenData {
  script: BriefingScript;
  voice: BriefingVoice;
  speed: number;
  deliveryAt: string;
}

export async function loadListenData(client: SupabaseClient): Promise<ListenData | null> {
  let rpc;
  try {
    rpc = adminRpc(createAdminClient());
  } catch {
    return null; // the server's Supabase key is not configured
  }
  const [briefing, settings] = await Promise.all([
    loadLatestBriefing({ user: client, rpc }, { leadMinutes: leadMinutesFromEnv(process.env.PULL_LEAD_MINUTES) }),
    loadListenSettings(client),
  ]);
  if (!briefing.ok) return null;
  const { voice, speed } = settings ?? DEFAULT_LISTEN_SETTINGS;
  return { script: scriptFor(briefing.value), voice, speed, deliveryAt: briefing.value.deliveryAt };
}

/** UI tests only: render with the stand-in tone renderer instead of Kokoro (no model download). */
export const fakeRendererEnabled = () => process.env.IMPARTLY_E2E_FAKE_RENDER === "1";
