# Handoff — 2026-07-10 session

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

You asked to pull it from the page until win/loss detection is more reliable — `index.html`'s `#llamaScorePanel` has `hidden`, and `js/app.js` no longer calls `renderLlamaScore()`. **The code is all still there and working** (`js/llama-score.js`, `Charts.renderBarChart`, the review-table UI in `app.js`) — re-enabling is a two-line change once you've got a better idea.

The core problem, confirmed by digging into real save data: **EU5 doesn't keep a "who won" field once a war concludes**, and worse, **it purges concluded wars from `war_manager.database` entirely** sometime after conclusion — sometimes faster than your autosave interval, so a war can go straight from `active` to *gone* with no snapshot ever showing it as concluded. The only survivor is a `locations` occupation snapshot, which is what the current heuristic (guess winner = whoever holds more locations) is built on. Whether that's good enough is genuinely unclear without more real examples to check it against.

## Open question for you

While hunting for a validation case, I found war `1442840586` in the `autosave_d7006736-13fe-4924-8632-c250da3124e4` series — 5 players (Holla Dolla Llama, Minimoose, nurd, DiePie, Zuup), real land exchange. It's `active` in the last autosave that has it, then vanishes in the next one (purged before conclusion was ever captured). At that last active snapshot: defender (Minimoose, alone) held slightly more locations (983) than the 4-country attacker coalition (921). **Do you remember who actually won?** If Minimoose lost despite holding more land, that's a real strike against the occupation-based heuristic and worth knowing before you build a v2.

(Also: `autosave_21b3a5ed-...` and all its `_1`–`_5` siblings are solo saves — no 5-player war exists there, in case you go looking.)

## Suggested next steps

1. Look over the map/Black Death fixes in the browser, confirm they look right on your end.
2. Think about the win/loss detection question above — a multi-save/campaign-sequence approach (diffing consecutive saves) might be the real fix, since single-save analysis structurally can't see a war that gets purged before your next autosave. That was a known tradeoff going in, now confirmed as a real, not just theoretical, limitation.
3. When ready, re-enable Llama Score: remove `hidden` from `#llamaScorePanel` in `index.html`, uncomment the `renderLlamaScore(result)` call in `js/app.js`'s `onParsed()`.
4. Minor: confirm the real in-game color for the `slaves` population class if you want it pixel-accurate (currently a guess).

## Repo note

`.git` in this directory is present but empty (`git status` fails with "not a git repository") — none of this session's work is committed anywhere. Let me know if you want me to `git init` and commit.
