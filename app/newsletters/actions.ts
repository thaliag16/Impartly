"use server";

// Server actions for the newsletter picker. Each one confirms the signed-in user with
// Supabase Auth, then hands the (untrusted) arguments to lib/feeds/picker.ts, which
// validates them, rate-limits discovery and calls the server-only SQL functions with that
// user's id. Next.js refuses server-action calls whose Origin is not this site.
//
// The page passes these to the client component as props; no client module imports this
// file (lib/supabase/boundary.test.ts checks client import graphs).

import { revalidatePath } from "next/cache";
import { pickerDeps } from "../../lib/feeds/deps";
import { addNewsletter, previewNewsletter, removeFeed, setFeedIncluded } from "../../lib/feeds/picker";
import type { AddOutcome, ChangeOutcome, PreviewOutcome } from "../../lib/feeds/types";
import { createComponentClient, getComponentUser } from "../../lib/supabase/server";

async function signedInUserId(): Promise<string | null> {
  const user = await getComponentUser(await createComponentClient());
  return user?.id ?? null;
}

export async function previewAction(query: unknown): Promise<PreviewOutcome> {
  const userId = await signedInUserId();
  if (!userId) return { ok: false, error: "signed_out" };
  return previewNewsletter(userId, query, pickerDeps());
}

export async function addAction(query: unknown): Promise<AddOutcome> {
  const userId = await signedInUserId();
  if (!userId) return { ok: false, error: "signed_out" };
  const out = await addNewsletter(userId, query, pickerDeps());
  if (out.ok) revalidatePath("/newsletters");
  return out;
}

export async function setIncludedAction(feedId: unknown, included: unknown): Promise<ChangeOutcome> {
  const userId = await signedInUserId();
  if (!userId) return { ok: false, error: "signed_out" };
  const out = await setFeedIncluded(userId, feedId, included, pickerDeps());
  revalidatePath("/newsletters");
  return out;
}

export async function removeAction(feedId: unknown): Promise<ChangeOutcome> {
  const userId = await signedInUserId();
  if (!userId) return { ok: false, error: "signed_out" };
  const out = await removeFeed(userId, feedId, pickerDeps());
  revalidatePath("/newsletters");
  return out;
}
