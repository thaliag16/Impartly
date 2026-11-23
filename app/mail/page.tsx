// Mail connection: connect Gmail (read-only), see the connected mailbox and its status,
// disconnect. Read as the signed-in user under RLS; the token column is not readable.

import { redirect } from "next/navigation";
import { createComponentClient, getComponentUser } from "../../lib/supabase/server";

export const dynamic = "force-dynamic";

const OUTCOMES: Record<string, string> = {
  connected: "Gmail is connected (read-only).",
  denied: "Gmail was not connected: access was not allowed.",
  not_granted: "Gmail was not connected: Google did not grant read-only access. Please try again and allow it.",
  failed: "Something went wrong. Please try again.",
  invalid: "That request was not valid or has expired. Please try again.",
  not_configured: "Gmail sign-in is not set up on this server yet (Google OAuth settings are missing).",
  disconnected: "Gmail is disconnected and its access was revoked.",
  revoke_failed: "Could not reach Google to revoke access, so nothing was removed. Please try again.",
};

const STATUS: Record<string, string> = {
  active: "Connected",
  error: "Needs reconnecting",
  revoked: "Revoked",
};

interface ConnectionRow {
  id: string;
  provider: string;
  account_address: string;
  status: string;
  last_synced_at: string | null;
}

export default async function MailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const client = await createComponentClient();
  const user = await getComponentUser(client);
  if (!client || !user) redirect("/login?next=%2Fmail");

  const params = await searchParams;
  const outcomeKey = Array.isArray(params.gmail) ? params.gmail[0] : params.gmail;
  const outcome = OUTCOMES[outcomeKey ?? ""];
  const { data } = await client
    .from("mail_connections")
    .select("id, provider, account_address, status, last_synced_at")
    .order("created_at");
  const connections = (data ?? []) as ConnectionRow[];

  return (
    <main style={{ maxWidth: 560, margin: "0 auto", padding: "48px 20px" }}>
      <h1 style={{ fontSize: 28, margin: "0 0 16px" }}>Mail</h1>
      {outcome ? (
        <p role="status" data-testid="mail-outcome">
          {outcome}
        </p>
      ) : null}
      {connections.length ? (
        <ul style={{ padding: 0, listStyle: "none", display: "grid", gap: 12 }}>
          {connections.map((c) => (
            <li key={c.id}>
              <div>
                {c.provider === "gmail" ? "Gmail" : c.provider}: {c.account_address} ({STATUS[c.status] ?? c.status})
              </div>
              <div>Last pulled: {c.last_synced_at ? new Date(c.last_synced_at).toUTCString() : "not yet"}</div>
              {c.provider === "gmail" ? (
                <form method="post" action="/api/mail/gmail/disconnect">
                  <input type="hidden" name="connection_id" value={c.id} />
                  <button type="submit" style={{ minHeight: 44 }}>
                    Disconnect
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p>No mailbox is connected.</p>
      )}
      <p>
        {/* A plain link: starting the OAuth flow is a full navigation to Google. */}
        <a href="/api/mail/gmail/connect" data-testid="connect-gmail">
          {connections.some((c) => c.provider === "gmail") ? "Reconnect Gmail" : "Connect Gmail"} (read-only)
        </a>
      </p>
      <form method="post" action="/auth/sign-out">
        <button type="submit" style={{ minHeight: 44 }}>
          Sign out
        </button>
      </form>
    </main>
  );
}
