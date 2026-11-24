import "server-only";

// The "Your next briefing" label for saved settings, from the scheduled pull's own SQL
// (public.delivery_next_after, server only), formatted in the user's zone.

import { nextBriefingLabel, type DeliverySettings } from "../../lib/schedule/delivery";
import { nextDelivery } from "../../lib/schedule/settings";
import { adminRpc, createAdminClient } from "../../lib/supabase/admin";

export async function nextBriefingFor(settings: DeliverySettings, now = new Date()): Promise<string | null> {
  let at: Date | null = null;
  try {
    at = await nextDelivery(adminRpc(createAdminClient()), now, settings);
  } catch {
    at = null; // the server's Supabase key is not configured
  }
  return at ? nextBriefingLabel(at, settings.timezone) : null;
}
