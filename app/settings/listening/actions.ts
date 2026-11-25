"use server";

// The listening settings screen's server action. It confirms the signed-in user with
// Supabase Auth, then validates the (untrusted) input and writes the user's own
// user_settings row under RLS through lib/briefing/settings.ts (the order may name only
// the user's own feeds). /listen reads the saved voice and speed on its next load; its
// stored clips are keyed by voice and speed, so a change renders the briefing again.
//
// The page passes this to the client component as a prop; no client module imports this
// file (lib/supabase/boundary.test.ts checks client import graphs).

import { revalidatePath } from "next/cache";
import { saveListenSettings, type ListenSettings, type ListenSettingsError } from "../../../lib/briefing/settings";
import { createComponentClient, getComponentUser } from "../../../lib/supabase/server";

export type ListeningSaveOutcome =
  | { ok: true; value: ListenSettings }
  | { ok: false; error: ListenSettingsError | "save_failed" | "signed_out" };

export async function saveListeningAction(input: unknown): Promise<ListeningSaveOutcome> {
  const client = await createComponentClient();
  const user = await getComponentUser(client);
  if (!client || !user) return { ok: false, error: "signed_out" };
  const out = await saveListenSettings(client, user.id, input);
  if (!out.ok) return out;
  revalidatePath("/settings/listening");
  revalidatePath("/listen");
  return out;
}
