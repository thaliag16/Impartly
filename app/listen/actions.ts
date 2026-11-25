"use server";

// The player's server action for the render cost log (GOAL.md Phase 2). After /listen
// renders a briefing on the device, it sends render-ahead's report here. This confirms the
// signed-in user with Supabase Auth, then writes one row to the user's own render log under
// RLS and checks that briefing against the budget (lib/briefing/render-log.ts). The answer
// carries only whether the briefing is within budget; the player shows nothing for it.
//
// The page passes this to the client component as a prop; no client module imports this
// file (lib/supabase/boundary.test.ts checks client import graphs).

import { writeRenderLog, type RenderLogOutcome } from "../../lib/briefing/render-log";
import { createComponentClient, getComponentUser } from "../../lib/supabase/server";

export async function logRenderAction(input: unknown): Promise<RenderLogOutcome> {
  const client = await createComponentClient();
  const user = await getComponentUser(client);
  if (!client || !user) return { ok: false, error: "signed_out" };
  const out = await writeRenderLog(client, input);
  if ("error" in out) return { ok: false, error: out.error };
  return { ok: true, over: out.budget.over };
}
