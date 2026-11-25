// The invented account the UI tests sign in with. It exists only in the fake Auth server
// (e2e/fake-auth-server.mjs); it is not a real account anywhere.
export const E2E_USER = { email: "e2e-reader@inbox.example", password: "e2e-invented-password" };

// A second invented account, for the UI tests that check one user cannot see another's rows.
export const E2E_OTHER_USER = { email: "e2e-other-reader@inbox.example", password: "e2e-other-invented-password" };

// Invented stand-in for SUPABASE_SECRET_KEY in the UI tests, so e2e/auth.e2e.ts can check
// that it never reaches a browser bundle.
export const E2E_SECRET_MARKER = "e2e-invented-service-key-marker-7f3a";
