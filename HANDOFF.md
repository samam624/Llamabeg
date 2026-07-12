# Handoff — 2026-07-12 session

Replaces the 2026-07-11 handoff below it in spirit. Server for local testing is running
at **http://localhost:8000** (`python3 -m http.server 8000` from this directory if it's
died — see README's "Running locally"). Current script cache-busting version string is
`ui-20260712-mapfixes5` (in `index.html`'s `<script src>` tags) — bump it again if you
change `js/map.js`/`app.js`/etc. and things "don't seem to have taken effect" — see the
caching gotcha at the bottom of this file, it bit us repeatedly tonight.

## What shipped this session

**Netlify deploy prep** (not deployed yet, per your "let me know before spending
credits" — nothing here touched Netlify itself). Fixed two real bugs in the build
pipeline before you ever ship it: `scripts/build-netlify-site.js` wasn't copying
`assets/` (logo/favicon would've been silently missing on the live site), and
`netlify.toml`'s CSP `img-src` didn't allow `eu5.paradoxwikis.com`, which is where every
tab/metric icon is hotlinked from — they'd have been silently blocked by the browser in
production even though there's no CSP enforced on localhost. Verified by actually
building (`node scripts/build-netlify-site.js`) and serving `dist/` locally.

**Renamed**: web app → **Llamabeg** (title/header). Recorder → **🪓 Llama Score Logging
Machine** (console banner + its own README) — no GUI of its own, so the "sprite" is an
axe emoji in the startup banner, not a graphic asset.

**Llama Score tab overhaul**:
- New **"Llama Score User Manual"** section at the top, open by default — 5-step
  walkthrough (download the Dashboard → run it → play → connect the campaign folder
  here → multiplayer note that there's no server/auto-sync, everyone runs their own
  recorder against their own save folder).
- Removed the single-sided-leftover-war-score win/loss guess entirely (both
  `js/llama-score.js` and the recorder's own copy in `llama-log-machine.js`) — a war
  where only one side's `attacker_score`/`defender_score` survives now falls straight
  to White Peace instead of guessing a winner off a partial-clear artifact. The
  two-sided "last known war score" check is untouched. Cleaned the now-dead
  "Leftover one-sided war score" copy out of the calculation dropdown and both UIs'
  (web + Dashboard) reason-label lookups.
- Removed ADM/DIP/MIL from the Military metrics tab (both Countries and Players); moved
  GP Rank to the first metric slot on Demographic.
- Countries/Players tables: default sort is now Income/mo (was whatever column
  happened to be first). Black Death renamed to **"Black Death Winner"**, now sorts
  ascending (lowest Lost % / least-affected first) by default.
- Added hover-only tooltips (native `title`, dotted-underline hint) explaining every
  non-obvious calculated column — Profit Efficiency, ADM/DIP/MIL, Income/1k people,
  Black Death Lost %, war Score, etc.
- Fixed Profit Efficiency's table heat-coloring: a single country with a -5000%-ish
  efficiency outlier was being used as the color scale's low end, which squished the
  entire meaningful 0-100% range into a thin green sliver — every country looked
  "good" regardless of real standing. Now any negative efficiency reads as flatly
  worst (full red); 0-100% gets the real gradient.

**Map — heat gradient overhaul** (development/population/control/prosperity):
- New unified palette (dark brown → tan → vivid green), replacing two near-identical
  black/red/green/blue "rainbow" variants, per your "pdx.tools reads better" feedback.
  The dark floor is a real dark brown, not literal near-black, so a genuine 0% no
  longer looks identical to "no data."
- Gradients now scale **min → max of whatever's in view** (world or a focused nation)
  instead of always 0 → max. Confirmed real ranges can be surprising — Prosperity's
  actual world range in one save was **-30% to 100%**, previously all silently
  clamped to the same 0% color.
- **Three real, distinct bugs** chased down and fixed on this same "why does the
  gradient look wrong" thread tonight, in order:
  1. Locations flagged `impassable` in `default.map` (mountains/wasteland + desert
     "non-ownable" corridors, ~1,971 of 28,573 locations — new `impassable` field in
     `map_data/locations.json`, baked by `tools/build-location-data.js`) were being
     read as genuine 0%-control/development land, dominating the min/max scale for
     whichever country's border happened to enclose them. Now excluded from the
     gradient entirely, unconditionally (even the ~166 that happen to carry real
     data — tried letting those through first, but per your feedback that still let
     atypical mountain values distort the scale for the rest of the country).
  2. `applyProvinceOwnerFallback()` (assigns a location's owner from its enclosing
     province when the location's own owner field is blank, for political-map-color
     correctness) was making completely blank-slate locations — no population, no
     development, no control, nothing, not impassable-flagged either — look "owned,"
     which fed into the same "owned but missing = 0" heuristic and reproduced the
     identical fake-0% problem through a different door. Fixed: a location now only
     gets the "missing field → 0" treatment if it has at least one OTHER real,
     directly-parsed heat-scale field; a total blank slate reads as neutral "no data"
     regardless of why it appears owned. Verified against real numbers: Serbia's
     population range went from a fake "0 – 25,874" to the correct **"2,121 –
     25,874"** (matches an independent hand-calculation exactly); Control went from
     fake "0% – 100%" to real **"8% – 100%"**.
  3. `map_data/locations.json` itself was being served from the browser's **stale
     HTTP cache** — unlike the JS files (which have a `?v=` cache-busting query
     string), this fetch had none at all, so even a full page reload could keep
     reusing the pre-fix JSON. Fixed with `{ cache: "no-store" }` on that fetch. This
     one cost real back-and-forth before it was found — worth remembering as its own
     category of bug, distinct from "the logic is wrong."
- **Markets mapmode**: merged the old separate "Markets" and "Market Access" tabs
  into one ("Markets"), colored by each market's real in-game color (not hashed) with
  a grey/dark→color gradient by access %. Tried a 75%-inflection "peaks then darkens"
  curve per your read of the game (¬75% access = time to split the market) — reverted
  per your feedback that it made the whole map look uniformly washed out (most real
  locations sit in a 30-70% band that never reached the peak). Now a plain steep power
  curve (`t^2.4`) instead — no inflection point, just falls into dark/grey faster than
  a straight linear blend.
- **Legend rendering**: now samples 9 points instead of 4 when building the CSS
  gradient bar, so non-linear curves actually show their real shape. Fixed centering
  to account for whichever side panel(s) are open (was always centering on the full
  map width, so it visibly drifted off-center whenever only one panel was open) —
  verified with 0px offset in all panel-open/closed combinations at your actual
  screen resolution (2524×1239).
- Political/Trade Goods/Religion/Culture legends removed entirely (too many
  categories to be useful — was a "+1040 more" list).
- **Sea/lake tiles**: click now shows a trimmed detail panel (only fields that
  genuinely apply — Market/Second Market/Market Attraction — instead of a wall of
  blank placeholders), and correctly resets any stale nation-focus view back to
  global when clicked. Border lines between sea tiles are unaffected (still drawn).
- **Removed entirely, not just hidden**: the dashed "leader line" pointer connecting
  a selected location to its detail panel, and the Roads section/parsing. Roads were
  removed at the source (`estate_manager.database` walk no longer even pushes
  road-type entries in either parser) per your call that the feature wasn't reliable
  enough to be worth the parse cost, even though the underlying data was confirmed
  correct (517 real gravel roads in one save, cross-validated text vs. binary) — it's
  just genuinely sparse and mostly on tiny AI/native nations, easy to never encounter.

**Income/mo fallback for older saves.** Confirmed root cause on a real 1.0.11 save
("Sindh" campaign): `last_month_gold_income` is absent from every single country (not
a parsing bug — the field or its fixed ID genuinely isn't there that early/that
version), while `economy.income`/`economy.expense` are present and already drive
Profit correctly. Cross-checked on a newer save where both fields exist — they track
within ~1-2% of each other — so `lastMonthGoldIncome` now falls back to `economy.income`
whenever the primary field is missing. **Known limitation, not fixed**: a separate
"Bohemia" save 3 months into a brand-new campaign has no income data at all (not even
`economy.income` — only 164 of 2,325 countries have any income figure that early,
exactly matching which ones have the primary field too) — this looks like the game
itself hasn't computed monthly income yet this early, not a parser gap. Nothing to fix
there without a later autosave from that same campaign to confirm.

## The caching gotcha, worth remembering

Two distinct caching issues bit us repeatedly tonight, on top of each other:
1. **Stale browser tab.** `map.js`/`app.js`/etc. are plain `<script src="...?v=...">`
   tags — an already-open tab never re-fetches until the page is reloaded AND the `?v=`
   string has changed. Several "still broken" reports this session turned out to be a
   tab that had been open since before the fix. Bumped the version string after every
   `map.js` change tonight; keep doing this (`ui-20260712-mapfixesN`, increment N).
2. **Stale `fetch()`ed data, separate from the script cache.** `map_data/locations.json`
   is loaded via a plain `fetch()` with no cache-busting at all — a normal reload could
   still reuse the browser's cached copy of the JSON even after the *code* reading it
   was already fixed and reloaded correctly. Now fixed with `{ cache: "no-store" }`,
   but worth remembering as a category if a similar "the code is right but the bug
   persists" situation comes up with any other `fetch()`-loaded data file.

## Suggested next steps

1. Confirm everything above looks right in a real browser session on your own machine
   — this session verified extensively with Playwright + real save data (including
   pixel-exact legend centering at your actual 2524×1239 resolution and hand-verified
   min/max numbers), but that's not a substitute for you actually looking at it.
2. When you're ready to actually deploy: `netlify link` + a first `netlify deploy` are
   the only remaining steps that touch Netlify's quota — nothing tonight did.
3. `map_data/` is gitignored (licensing) so the regenerated `locations.json` (with the
   new `impassable` flag) only exists on this machine — if you set up the map on
   another machine, re-run `tools/build-location-data.js` after copying your own EU5
   map files in, or the impassable-terrain fix won't apply there until you do.

---

# Handoff — 2026-07-11 session (superseded, kept for history)

This replaces the 2026-07-10 handoff below it in spirit (not literally kept — that one
predated Llama Score even being wired into the UI and described `.git` as empty, which
is no longer true; see `git log`). Server used for local testing tonight was
`python -m http.server 8791` — kill it if it's still running (`taskkill /F /IM
python.exe` on Windows, or just close the terminal).

## What shipped this session

**UI reorg: one crowded "Statistics" tab → five real tabs.** The old tab crammed
Overview/Trends/Players/Black Death/Llama Score/Countries into a 2-column CSS grid only
two sections were coded to span, so panels landed in mismatched half-width columns —
the "too wide and strange" layout that kicked this off. Now: **Load Save / Metrics /
Graphs / Llama Score / Map**, each a plain single-column stack. Full writeup in
`README.md`'s `### UI` section (search "Tab layout: Load Save / Metrics").

**Save-loading UX moved into its own tab.** The uploader + "Recent saves" panel used to
sit permanently above the tab nav, even after a save was locked in. It's now the "Load
Save" tab — the only one visible before any save is parsed, auto-navigated away from
into Metrics once one loads (but only if you were actually on it — reloading a
different save while on Map/Graphs/Llama doesn't yank the view away from what you were
looking at).

**Map aspect ratio fixed.** Was `height: min(76vh, 760px)` at whatever width the
(now full-width) container gave it — a very short, very wide banner on a wide monitor.
Now `aspect-ratio: 16/10` with a `max-width: 1500px` cap, closer to an actual monitor
shape.

**Logo + more wiki sprite icons.** `assets/llama-logo.png` (a Kuzco-as-llama image the
user provided) is now the header logo and favicon. Added EU5-wiki-sourced icons
(same `Special:Redirect/file/<Name>.png` pattern `js/map.js` already used for map-mode
buttons) to each top-level tab and to the Key/Economy/Military/Demographic metric-tab
buttons — every filename was verified with a `curl` HEAD request first (a few obvious
guesses like `Black Death.png`/`Statistics.png` 404 on the wiki).

**Removed the "DLCs Enabled" row** from the Overview stat grid (not useful per the
user).

**Black Death "Lost %" column is now color-graded**, green (least population lost) to
red (most), scaled to the *loaded save's own* min/max rather than a fixed 0–100% axis —
real tallies cluster narrowly (e.g. 20–40% in one test campaign) and would otherwise
all read as the same shade against the full range.

**Llama Score: fixed departed players still scoring (and still being scored against).**
Real bug, found via the user's own campaign: a player (`thepro24`) who'd left two
sessions earlier was still topping the leaderboard, because nothing in a save or a
recorder snapshot ever records "no longer connected" — a country's player list is just
its last `played_country` entry, which never clears on its own (confirmed by reading
the actual parser code, not assumed). The existing `buildDepartureDates()` auto-exclude
in `js/llama-score.js` can only fire if a snapshot ever recorded a country's players
list going empty, which structurally can't happen for someone who just stops showing
up — so it wasn't catching this in practice, live recorder or not.

Fix: the existing "Hide" button on the Players table (`eu5-analyzer-excluded-players`)
is now wired into `computeLlamaScores`/`computeFromLedger` as an `excludedPlayers` set.
Hiding a player drops their leaderboard entry, excludes their own war rows
(`"player-hidden"`), and — the part that was still missing after the first pass
tonight — also excludes *their opponents'* rows against them
(`"opponent-departed"`, via a new `attributedPlayerFor(country)` lookup on the enemy
side of each war row). Without that third piece, an opponent who'd actually fought the
departed player kept a frozen win/loss score from that fight even after the phantom was
hidden. Verified against the real ledger data for campaign `3baa76aa-...`: before the
fix, DiePie carried a permanent `-5.00` from a war against the by-then-departed
`thepro24`; after hiding `thepro24`, that row shows `auto`-excluded with score `-`.
`E`/`A` counts and `isPvP` themselves are deliberately untouched by hiding someone —
they reflect who was actually fighting at the time, so a legitimately-fought war from
before someone departed doesn't get its score rewritten too.

## Also pending in this working tree (not this session's work, not audited in depth)

`git status` shows a chunk of unrelated in-progress work from earlier — Supabase/Netlify
hosting prep (`supabase/`, `netlify.toml`, `scripts/`, `.env.example`,
`docs/SUPABASE_NETLIFY_RELEASE.md`), a `js/ledger-connect.js` and
`llama-score-automatic-logging-machine/parse-worker.js` addition, and modified parser/
map/recorder files. That work predates tonight's UI session — `docs/
SUPABASE_NETLIFY_RELEASE.md` has its own writeup and cost guardrails if picking it back
up. Committed tonight alongside the UI work per your "update the git" instruction, but
not re-verified line-by-line here — if something in that batch looks off, that's the
place to start reading, not this file.

## Suggested next steps

1. Confirm the tab reorg/map ratio/llama fix all look right in a real browser session
   (this session verified everything with Playwright + real save/ledger data, not a
   live human click-through).
2. If more players turn out to be "phantom farming" scores against each other, the Hide
   button is now the fix — no code changes needed, just hide them from the Players tab.
3. Revisit the Supabase/Netlify prep work above whenever that's back on the priority
   list; nothing tonight touched it.

---

# Handoff — 2026-07-10 session (superseded, kept for history)

Server is running at **http://localhost:8000** (if it's died by tomorrow: `python -m http.server 8000` from this directory — see README's "Running locally").

## What shipped this session

**war_manager / Llama Score data layer** (new, both parsers)
- `js/clausewitz.js` / `js/clausewitz-binary.js`: new `war_manager.database` selective extractor (`extractWarFields`), full `playerSessions` history (not just current controller), `score.score_rank` (ADM/DIP/MIL) wired into `extractCountryFields`.
- `js/eu5-fixed-ids.js`: 23 new binary fixed IDs for `war_manager` and its sub-fields, all derived and cross-validated against melted text.
- `js/llama-score.js` (new file): pure scoring engine — formula, win/loss occupation heuristic, manual-override support. **Not wired into the UI right now** (see below).
- Validated: 0 field mismatches, binary vs. text, across all 6 melted-paired saves.

**Binary parser bug fix (real root cause, not a workaround)**
- `0x029c` was mis-documented/mis-handled as a 4-byte int32; it's actually 8 bytes. This was the cause of the long-standing "some saves show 0 countries" crash (`situation_manager` desync eating the rest of the file).
- Fixed in `js/clausewitz-binary.js` (`readScalarValue`/`skipScalarValue`/`resolveToken`).
- Result: **59/59 of your real saves now parse cleanly** (was 58/59). `autosave_a881d67a-...` in particular is fully fixed.

**Map fixes** (`js/map.js`)
- Player-nation labels (were landing outside actual territory for sprawling empires) — now snap to the closest real owned point instead of a raw centroid average.
- Player borders (were "spotty"/asymmetric) — border detection only flagged a boundary when the *current* pixel was the player-owned side of a transition, missing roughly half of any diagonal border's length. Now symmetric.
- Population-breakdown pie/legend colors — were assigned by per-location rank position (so the same pop class got different colors in different places); now a fixed lookup matching your spec (burghers=yellow, soldiers=red, laborers=grey, clergy=white, peasants=green, nobles=blue, tribesmen=orange). `slaves` isn't in your list — currently a placeholder purple, unconfirmed against the game's real legend.

**Black Death**
- Table now filters to player-controlled countries only (was showing all ~2500 real countries).
- Column header changed from ambiguous "Population (now/end)" to "(end)" for a concluded event / "(now)" only while genuinely ongoing — the underlying math was already correct, this was a labeling bug.

**GP Score redesign**
- Replaced ADM/DIP/MIL-rank-sum with `great_power_rank` (present from game start in every save, unlike `great_power_points`/`regional_power` which only activate in a later era). Formula: `max(0, 27 − rank + 1) × 75`, calibrated against a real game-computed tier boundary (`regional_power=true` forms an exact rank 12–27 band in the one save where it was active).
- This code exists but currently only matters once Llama Score is re-enabled (see below).

## Current state: Llama Score is OFF

*(Historical note: this is no longer true as of tonight — Llama Score has been live in the UI for a while, with its own tab as of this session. Left as-is below for the historical record.)*

You asked to pull it from the page until win/loss detection is more reliable — `index.html`'s `#llamaScorePanel` has `hidden`, and `js/app.js` no longer calls `renderLlamaScore()`. **The code is all still there and working** (`js/llama-score.js`, `Charts.renderBarChart`, the review-table UI in `app.js`) — re-enabling is a two-line change once you've got a better idea.

The core problem, confirmed by digging into real save data: **EU5 doesn't keep a "who won" field once a war concludes**, and worse, **it purges concluded wars from `war_manager.database` entirely** sometime after conclusion — sometimes faster than your autosave interval, so a war can go straight from `active` to *gone* with no snapshot ever showing it as concluded. The only survivor is a `locations` occupation snapshot, which is what the current heuristic (guess winner = whoever holds more locations) is built on. Whether that's good enough is genuinely unclear without more real examples to check it against.

## Repo note

*(Historical note: also no longer true — see `git log`.)*

`.git` in this directory is present but empty (`git status` fails with "not a git repository") — none of this session's work is committed anywhere. Let me know if you want me to `git init` and commit.
