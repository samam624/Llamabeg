---
name: deploy-llamabeg
description: How to ship a change to the live Llamabeg site (llamabeg.netlify.app) and its Supabase backend - deploying via the Netlify CLI (not git push), the mandatory cache-bust version bump on any JS/CSS change, Supabase migrations, and the anon-RPC chunking limit. Use whenever a task involves deploying this app, pushing a Supabase migration, or debugging "I deployed but nothing changed" for this project.
---

# Deploying Llamabeg (web app + Supabase backend)

Three systems are involved and **none of them auto-sync with each other**:
GitHub (`origin/master`), Netlify (the live site), and Supabase (the
backend DB). Assuming any one of them updates the others is the #1 way to
waste a deploy or ship a no-op.

## The three things that are NOT true (learned the hard way)

1. **`git push` does not deploy anything.** This Netlify site has no
   GitHub connection (`repo: null`, `build_settings: {}` - confirmed via
   `netlify api getSite`). It was only ever deployed via the CLI
   (`deploy_source: "cli"`). Pushing to GitHub is for history/review only;
   it never touches the live site.
2. **A successful `netlify deploy` does not mean users see your change.**
   See the cache-bust section below - this is the one that actually cost
   real deploys and real debugging time on 2026-07-18.
3. **`npm run build` locally does not match a real deploy.** It runs
   without Supabase env vars and silently degrades ("shared-save backend
   disabled in this build"). Only `netlify deploy --build` (which injects
   the site's real configured env vars before running the build command)
   produces a build equivalent to production.

## The cache-bust rule (read this before touching js/ or css/)

`netlify.toml` serves `/js/*` and `/css/*` with
`Cache-Control: public, max-age=31536000, immutable` - a full year,
keyed entirely on the `?v=vX.Y.Z` query string that `index.html` appends
to every `<script src>`/`<link>` tag. That string is **hand-maintained**
- `scripts/build-netlify-site.js` just copies files, it does no
templating or auto-versioning.

**If you change any file under `js/` or `css/` and don't bump that
version string, the fix will not reach anyone whose browser (or
Netlify's own CDN edge) already cached the old one - indefinitely.** A
hard reload happens to bypass this (which is why a fix can look "fixed"
for you and broken for everyone else), and a brand-new/incognito browser
profile happens to dodge it too (which is why a fresh-profile Playwright
check can pass while the bug is still live for real users) - neither of
those is a reliable signal that the fix actually shipped.

**Before every deploy that touches `js/` or `css/`:**
```bash
# bump the version everywhere it appears in index.html (currently v1.3.1)
sed -i 's/v1\.3\.1/v1.3.2/g' index.html   # pick the next version
grep -c 'v1\.3\.2' index.html              # sanity check the count didn't drop
```
Do this even for a one-line JS fix. There is no size threshold that makes
it safe to skip.

## Deploy checklist

Netlify deploys are budget-limited on this account (the user has hit
"close to the limit" before) - verify everything possible locally BEFORE
spending one.

1. `node --check js/whatever.js` on every JS file you touched (catches
   syntax errors for free, no deploy needed).
2. If you touched `js/` or `css/`: bump the cache-bust version in
   `index.html` (see above). If you only touched `index.html` itself
   with no JS/CSS changes, you still need a version bump if any
   reference inside it needs a fresh fetch - check first.
3. `npm run build` locally as a smoke test (won't have Supabase env vars,
   but will catch a build-script crash before you spend a real deploy).
4. Deploy for real, letting Netlify inject the site's actual env vars:
   ```bash
   netlify deploy --build --prod --message "<what changed>"
   ```
   (`--build` is the default now but pass it explicitly for clarity; it's
   what makes `SUPABASE_URL`/`SUPABASE_ANON_KEY` get baked into the
   generated `config.js` - a bare `netlify deploy` without `--build`
   would ship whatever's already in your local `dist/`, which is usually
   the degraded no-Supabase build from step 3.)
5. Verify against the LIVE URL, not localhost - `curl` the deployed
   `index.html` for the new version string, and/or run a quick
   Playwright check (see Verification below) against
   `https://llamabeg.netlify.app` directly.

Site identity (already linked, no re-linking needed):
`.netlify/state.json` → siteId `dc3b4fbf-c629-4788-8e49-8341e8ed2fcc`,
project name `llamabeg`, production URL `https://llamabeg.netlify.app`.

## Supabase migrations

The project is already linked (`supabase/config.toml` +
`supabase/.temp/linked-project.json`). To push a new migration:
```bash
npx supabase db push
```
This applies any `supabase/migrations/*.sql` file not yet recorded as
applied on the remote. **Migrations are append-only** - never edit a
migration file that's already been pushed (even if nobody else has
pulled it yet); write a new migration instead. This project literally
did this once already: `20260718040000_...rpc.sql` shipped a combined
RPC that turned out to hit a timeout, so
`20260718050000_..._chunked_rpc.sql` dropped it and replaced it with
three narrower functions, rather than editing the first file.

Local Docker-related warnings during `db push`
("failed to inspect docker image...") are harmless - they're about the
local dev-migration cache, not the actual push to the remote database.

`.env.local` at the repo root already has `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` for any script that
needs them (e.g. `npm run data:import`, ad-hoc verification scripts).
**Never let the service-role key anywhere near browser-shipped code** -
only the anon key belongs in `config.js`/`js/*.js`. Anything that needs
service-role privileges (bulk imports, admin scripts) stays a local
Node script, never a page the browser loads.

## The anon-role RPC timeout limit

The `anon`/`authenticated` Postgres roles have a noticeably shorter
`statement_timeout` than `service_role`. A single RPC call carrying too
much data WILL time out under anon even though the identical payload
works fine under a service-role connection - confirmed directly: a
combined "upsert campaign + 49 snapshots + 116 events" call timed out
under anon (`57014 canceling statement due to statement timeout`) despite
being trivial for the CLI importer's service-role connection.

If you're writing a browser-callable (anon-key) RPC that touches
`eu5_campaign_snapshots` or anything with a similarly large embedded
`jsonb` payload per row, **chunk it small** - this project settled on 1
snapshot / 100 events per call, mirroring
`scripts/import-llama-ledgers-to-supabase.js`'s own
`TABLE_CHUNK_SIZES` (which had already independently learned the same
lesson under the *unlimited* service-role connection - that's a strong
signal the row size itself is the constraint, not just the timeout).

## Verification methodology

Playwright (headless Chromium) is the reliable way to prove a fix works
against the real production URL, not just the code:
```bash
cd <scratchpad>
npm init -y && npm install playwright && npx playwright install chromium
node your-check.js   # navigate to https://llamabeg.netlify.app/..., assert on real DOM state
```
Clean up `node_modules`/`package.json`/your script from the scratchpad
when done - don't leave it lying around.

**Known blind spot:** a fresh `browser.newContext()` always has an empty
HTTP cache, so it can *never* catch the cache-bust bug described above -
it's structurally a guaranteed cache-miss, same as a genuinely
first-ever visitor. A fresh-profile Playwright pass is good evidence the
*logic* is correct; it is not evidence that *already-cached real users*
will see the change. Only the version-bump mechanism (or manually
forcing a warm-cache reload) actually tests that path.

## Quick reference: where the real data lives

- EU5 save files: `%USERPROFILE%\Documents\Paradox Interactive\Europa Universalis V\save games`
- Real Llama Score Dashboard install + its recorder ledger data:
  `%USERPROFILE%\Documents\Llama-Score-Dashboard-win32-x64\data\campaigns\<campaign-key>\`
  (campaign key = the playthrough's UUID, same one embedded in a
  `?save=<uuid>_<date>` share link and in a real autosave's own filename
  - `autosave_<uuid>.eu5`)
- This repo's own `llama-score-automatic-logging-machine/data/` is
  fixture/test data only - never confuse it with the real folder above.
