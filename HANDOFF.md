# Handoff — 2026-07-11 session

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
