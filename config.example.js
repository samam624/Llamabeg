// Public browser config for the shared-save backend (Supabase Storage - see
// js/share-store.js). Copy this file to config.js and fill in the two values,
// OR run `node scripts/write-config.js` to generate config.js from your
// .env.local. config.js is gitignored (kept out of source control) and lives
// at the site ROOT on purpose: netlify.toml immutable-caches /js/* for a
// year, but the root gets no-store, so a rotated key propagates immediately.
// On Netlify, scripts/build-netlify-site.js generates config.js from the
// SUPABASE_URL / SUPABASE_ANON_KEY build env vars instead.
//
// BOTH values below are the PUBLIC ones. The anon (a.k.a. publishable) key is
// designed to be exposed in frontend code and is gated by row-level security
// - it is NOT a secret. NEVER put the service_role key here; that one stays
// server/CLI-only (see .env.example).
//
// Omit this file entirely and the app still works - it just falls back to
// local-only "Copy link" (a link only resolves in a browser that already
// uploaded that save).
window.EU5_CONFIG = {
  supabaseUrl: "https://YOUR_PROJECT_REF.supabase.co",
  supabaseAnonKey: "YOUR_PUBLIC_ANON_KEY",
};
