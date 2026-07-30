# Black Death per-country deaths on 1.3.11+ saves — fix status & how to finish it

## The problem (fully root-caused — see `docs/ARCHITECTURE.md`'s "Black Death
analyzer" section, 2026-07-30 updates, for the full investigation)

Game patch 1.3.11 stopped serializing a per-country Black Death death
breakdown into the save file. Confirmed genuinely unrecoverable from a
1.3.11+ save on its own:

- `disease_outbreak_manager` no longer exists as a top-level key.
- 1.3.11 instead flattens disease records straight onto the gamestate top
  level, keyed by the outbreak's own `identity` number. That record is
  provably the right one (its start-date field decodes to the exact real
  Black Death start date), but its per-location death array is a pruned
  resistance-simulation remnant — on the one real campaign checked, it
  summed to ~11% of the true historical total from the same campaign's
  pre-1.3.11 save. It doesn't decay tick-by-tick (stable across 5 real
  in-game years), but it lost ~89% of the total over a 91-year patch gap,
  consistent with per-location entries being dropped once that location's
  resistance simulation resolves, with no cumulative counter kept behind.

**Conclusion, agreed with the user 2026-07-30**: the true total cannot be
derived from a 1.3.11+ save. Since an outbreak's death toll is fixed forever
once the outbreak ends, the fix is to capture it opportunistically (from any
save that still has it) and let later saves of the same campaign reuse the
captured value.

## What's implemented (code written, NOT yet deployed)

1. **`supabase/migrations/20260730080000_eu5_black_death_captures.sql`**
   New table `eu5_black_death_captures` (`playthrough_id`,
   `outbreak_identity`, `deaths_by_country` jsonb, `start_date`, `end_date`,
   `game_version`, `captured_at`), keyed by `(playthrough_id,
   outbreak_identity)` — both values already present in every save's own
   metadata/`situation_manager`, no filename parsing needed (contrast with
   the llama-ledger feature's filename-derived `campaign_key`). Anon role
   gets `SELECT` only (RLS policy, `using (true)`); writes go through a new
   `security definer` RPC `eu5_capture_black_death(...)`, matching the
   existing `eu5_upsert_campaign` pattern in
   `20260718050000_eu5_upsert_campaign_ledger_chunked_rpc.sql`. The RPC does
   `ON CONFLICT (playthrough_id, outbreak_identity) DO NOTHING` — only the
   first-ever capture for an outbreak is kept, so a later, possibly-worse
   reading can never clobber a known-good one.

2. **`js/share-store.js`** — two new functions on the existing
   `ShareStore` object (same no-SDK, plain-`fetch` style as everything
   else in this file):
   - `captureBlackDeath(playthroughId, identity, deathsByCountry, startDate, endDate, gameVersion)`
     — fire-and-forget upsert via the RPC above.
   - `fetchBlackDeathCapture(playthroughId, identity)` — direct REST
     `GET` against the table (no RPC needed for a plain read), returns the
     captured `deaths_by_country` jsonb or `null`.

3. **`js/app.js`**:
   - `renderBlackDeath()`'s Deaths/Lost % columns now render **"Not enough
     data"** (distinct from the existing "–" for "hasn't happened yet")
     when `result.blackDeath.__noDataAvailable` is set.
   - New `reconcileBlackDeathWithBackend(result)`, called right after the
     existing `renderBlackDeath(result)` call in `onParsed()`. Best-effort,
     never blocks anything else:
     - If the just-parsed save HAS `deathsByCountry`: fires
       `ShareStore.captureBlackDeath(...)` in the background (errors
       swallowed).
     - If it DOESN'T (but the Black Death has happened —
       `blackDeath.status` set): awaits
       `ShareStore.fetchBlackDeathCapture(...)`. If found, patches
       `result.blackDeath.deathsByCountry` and re-renders (with a summary
       note that the numbers came from an earlier save of the campaign).
       If not found, sets `__noDataAvailable` and re-renders (shows "Not
       enough data").
   - Guards against a stale re-render if the user loads a different save
     while the async lookup is still in flight (`if (latestResult ===
     result)` / `if (result.blackDeath !== bd)` checks).

`js/parse-worker.js` already whitelists `blackDeath` in its postMessage
payload — no change needed there.

## What's NOT done yet

- [ ] **Apply the migration**: `npx supabase db push` (project is already
      linked — see the `deploy-llamabeg` skill). Docker-related warnings
      during this are harmless.
- [ ] **Bump the cache-bust version.** `js/app.js` and `js/share-store.js`
      changed, so `index.html`'s `?v=v1.3.8` query strings (13 occurrences,
      confirmed via `grep -c` before touching it) need bumping to the next
      version (e.g. `v1.3.9`), AND the two matching in-code constants:
      `js/app.js`'s `ASSET_VERSION` and `js/parse-worker.js`'s
      `WORKER_ASSET_VERSION` (both currently `"v1.3.8"` too — all three
      must move together, this is what actually version-gates the parsing
      Web Worker, not just the `<script>` tags).
- [ ] **Local smoke test**: `node --check js/app.js js/share-store.js`
      (already done, passes) and `npm run build` (won't have real Supabase
      env vars, just confirms the build script itself doesn't crash).
- [ ] **Deploy**: `netlify deploy --build --prod --message "..."` — per
      standing instruction, confirm with the user immediately before
      running this, every time, even though they already said "hold for
      now" once this session.
- [ ] **Verify against the live URL** (not localhost) — a real save upload
      through the actual deployed site, checking: (a) a pre-1.3.11 (or
      not-yet-pruned 1.3.11) save with real Black Death data triggers a
      capture (spot-check the row landed in
      `eu5_black_death_captures` via the Supabase dashboard or a REST
      query), (b) a later 1.3.11+ save of the SAME campaign (same
      `playthrough_id`) then shows the recovered numbers with the "earlier
      save" note instead of "–", (c) a campaign with no capture on record
      anywhere shows "Not enough data", not "–" and not a crash.
- [ ] **CHANGELOG.md entry** — intentionally not added yet; per repo
      convention entries describe verified, shipped behavior, and this
      hasn't been deployed or exercised against the real backend yet.

## Files touched so far (uncommitted)

- `supabase/migrations/20260730080000_eu5_black_death_captures.sql` (new)
- `js/share-store.js`
- `js/app.js`
- `docs/ARCHITECTURE.md` (investigation writeup)
- `docs/BLACK_DEATH_CAPTURE_FIX.md` (this file)
