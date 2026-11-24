"use server";

// The settings screen's server action. It confirms the signed-in user with Supabase Auth,
// validates the (untrusted) input server-side (lib/schedule/settings.ts), writes the
// user's own user_settings row under RLS, and returns the next briefing for the saved
// values. The database trigger resets the scheduled pull for the new time.
//
// The page passes this to the client component as a prop; no client module imports this
// file (lib/supabase/boundary.test.ts checks client import graphs).

import { revalidatePath } from "next/cache";
import { nextBriefingFor } from "./next";
import type { SaveOutcome } from "../../lib/schedule/delivery";
import { saveDeliverySettings } from "../../lib/schedule/settings";
import { createComponentClient, getComponentUser } from "../../lib/supabase/server";

export async function saveDeliveryAction(input: unknown): Promise<SaveOutcome> {
  const client = await createComponentClient();
  const user = await getComponentUser(client);
  if (!client || !user) return { ok: false, error: "signed_out" };
  const out = await saveDeliverySettings(client, user.id, input);
  if ("error" in out) return out;
  revalidatePath("/settings");
  return { ok: true, value: out.value, next: await nextBriefingFor(out.value) };
}
