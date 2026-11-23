// Sign in with the email and password of a user created in the Supabase project.
// The form posts to /auth/sign-in (server-side); nothing here runs Supabase in the browser.

import { safeNextPath } from "../../lib/auth/access";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  invalid: "That email and password did not match an account.",
  not_configured: "Sign-in is not set up on this server yet (Supabase settings are missing).",
  unavailable: "Sign-in is unavailable right now. Please try again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const next = safeNextPath(one(params.next));
  const error = ERRORS[one(params.error) ?? ""];
  return (
    <main style={{ maxWidth: 420, margin: "0 auto", padding: "48px 20px" }}>
      <h1 style={{ fontSize: 28, margin: "0 0 16px" }}>Sign in to Impartly</h1>
      {error ? (
        <p role="alert" data-testid="login-error">
          {error}
        </p>
      ) : null}
      <form method="post" action="/auth/sign-in" style={{ display: "grid", gap: 12 }}>
        <input type="hidden" name="next" value={next} />
        <label style={{ display: "grid", gap: 4 }}>
          Email
          <input name="email" type="email" autoComplete="email" required style={{ minHeight: 44 }} />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          Password
          <input name="password" type="password" autoComplete="current-password" required style={{ minHeight: 44 }} />
        </label>
        <button type="submit" style={{ minHeight: 44 }}>
          Sign in
        </button>
      </form>
    </main>
  );
}
