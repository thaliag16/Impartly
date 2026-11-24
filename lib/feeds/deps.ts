import "server-only";

// Real dependencies for the newsletter picker: the service-role RPC (server-only SQL
// functions that take the user id) and the polite web fetcher for discovery.
//
// UI tests start the server with IMPARTLY_E2E_FAKE_WEB=1, which swaps the network under
// the fetcher for canned responses (lib/feeds/e2e-fake-web.ts). That only ever removes
// network reach, and it is refused on Vercel so a deployment cannot run with it.

import { loadCatalog } from "../sources/web/catalog";
import { createWebFetcher, type WebFetcher } from "../sources/web/fetcher";
import { adminRpc, createAdminClient } from "../supabase/admin";
import { fakeResolve, fakeTransport, fakeWebEnabled } from "./e2e-fake-web";
import type { PickerDeps } from "./picker";

function fetcher(): WebFetcher {
  return fakeWebEnabled() ? createWebFetcher({ resolve: fakeResolve, transport: fakeTransport }) : createWebFetcher();
}

export function pickerDeps(): PickerDeps {
  return { rpc: adminRpc(createAdminClient()), fetcher, catalog: loadCatalog() };
}
