# Whole-repo review follow-up — fix plan (2026-08-14, afternoon session)

Written before any edits in this pass, specifically so the plan survives if this session gets
interrupted (it did once already today). Source: a 9-agent adversarial review of the morning
session's own bug-fix commits (`7362dae`, `34ea8a3`), each finding independently re-verified by
reading the actual code before being listed here. Checkboxes get ticked as each fix lands; if this
file still has unchecked boxes and no explanation, the fix wasn't done yet.

**Status: all 13 code fixes (1-7, 9-14) landed and re-verified. #5 got a documentation fix (UI
tooltip) instead of a code fix, by design - see its entry. #8 stays deferred, also by design - see
its entry. #15/#16 remain deferred, as originally planned.**

## Confirmed bugs (verified directly against code)

- [x] **1. `fought()` reads a stale Map after the participant dedup.**
  `js/llama-score.js:255-256` (`computeLlamaScores`) and `:1388-1389` (`computeFromLedger`) both
  build `participantByCountry` from the raw, undeduped `war.participants` array (Map construction
  keeps the LAST entry for a repeated country), while `dedupedParticipants` a few lines away keeps
  the FIRST. A left-then-rejoined player can be wrongly auto-excluded as "no-battle-losses".
  **Fix:** build `participantByCountry` from the already-deduped participant list in both places
  instead of the raw array.

- [x] **2. War dedup now runs before the outcome-decisiveness check.**
  `js/llama-score.js:1374-1386`. Old code only marked an event "seen" after it survived the
  indecisive-outcome `continue`; new code dedups to the single latest-dated event first, so if
  that latest event's outcome is indecisive (e.g. its snapshot got pruned) the war now produces
  **zero** rows even when an earlier duplicate had a decisive outcome — worse than the
  double-counting bug this was fixing.
  **Decision:** do NOT fall back to the earlier duplicate's outcome. Per the fix's own reasoning,
  an earlier duplicate is a transient tracking-loss event (the war hadn't really ended yet), so
  its "decisive" outcome would be computed from a truncated/wrong window — using it would
  reintroduce a correctness bug, just a quieter one. The right fix is to keep picking the latest
  (true) event, but stop silently swallowing the indecisive case: fold it into the existing
  `unscoreableCount` counter (already surfaced in the UI: "N more war(s) disappeared with no
  recorded state to score them from...") instead of a bare `continue`.
  **Fix:** change `unscoreableCount` from `const` to `let`, increment it when the post-dedup
  outcome comes back indecisive.

- [x] **3. Attendance "manage" button can bypass seeding and write `from: undefined`.**
  `js/app.js` — `openAttendanceModal` (1282-1320) computes `nothingNew` from
  `attendance.lastCheckpointDate`, which is only ever initialized by `maybePromptSessionAttendance`
  (1326-1343). The manage-button handler (1345-1362) calls `openAttendanceModal` directly,
  skipping that seeding step. If `lastCheckpointDate` is still unset (reachable: the war-corrections
  modal open during the very first `draw()` for a brand-new campaign blocks the auto-seed via its
  own open-modal guard), `nothingNew` is false, the checklist renders, and Submit writes
  `{from: undefined, to: <date>}`. `JSON.stringify` drops the key; `dateKey(undefined)` returns 0;
  `isAbsentDuring`'s `k >= dateKey(r.from)` is then true for every real date — the player's entire
  campaign history silently becomes "absent". This is the exact failure class the `isValidEu5Date`
  fix (same commit) was built to close, reached through a path that fix doesn't cover.
  **Fix:** move the "seed `lastCheckpointDate` if unset" guard into `openAttendanceModal` itself
  (top of the function, before `nothingNew` is computed), so every caller gets the invariant, not
  just the auto-prompt path. Leave `maybePromptSessionAttendance`'s own silent-seed-and-return-
  without-opening-a-dialog behavior untouched (that's the intentional "don't ask about a campaign's
  entire history the first time you see it" UX) — the new guard is a no-op there and a real fix for
  the manage-button path.

- [x] **4. Land-transfer sign-check removal has no replacement guard.**
  `js/llama-score.js:869-917` and the mirrored copy in
  `llama-score-automatic-logging-machine/llama-log-machine.js`. Dropping the opposite-sign
  requirement (to catch real same-signed pile-on wars) reopens the false positive the removed
  check's own comment names: two unrelated same-signed swings on the two tracked principals can
  now clear `Math.abs(spread) >= 2` and get scored as a decisive transfer between sides that never
  exchanged territory.
  **Fix — better than either the old or the current code:** the function already computes exact
  location-ID sets per side (`principalFieldUnion(..., "locationsGained"/"locationsLost")`,
  currently only used for the UI breakdown display, line ~945-948). Use them as ground truth: if
  `attackerLocationsLost` overlaps `defenderLocationsGained`, or `defenderLocationsLost` overlaps
  `attackerLocationsGained`, that *proves* land moved between these two specific sides — decisive,
  regardless of net-delta sign or spread. When that ID data isn't available (an older war recorded
  before this tracking existed — `principalFieldUnion` returns `null`, not `[]`, in that case),
  fall back to today's spread-based heuristic exactly as-is (same tradeoff already accepted this
  session). This fixes the false positive when ID data exists AND preserves the pile-on fix.
  Apply identically to both files.

- [x] **5. Desktop dashboard lost its only automatic absence signal, with no replacement.**
  `llama-dashboard/main.js:622` still calls `computeFromLedger` with 5 args (no `absentRanges`),
  and this session's diff deleted `computeAutomationDepartures` (dashboard's prior, if unreliable,
  signal) with nothing wired in to replace it.
  **Decision:** the new attendance feature is explicitly browser-`localStorage`-only by design
  (same model the manual Hide list already uses on the website) — Electron's dashboard process
  doesn't share that storage, and building a full second attendance-prompt UI + sync layer in the
  dashboard is a real new feature, not a bug fix, and not something to improvise without scoping it
  with the user first (this project has a documented real incident from exactly this
  "3 separate unsynced player-visibility stores" shape). **No code fix in this pass** — instead,
  added a `title` tooltip on the dashboard's "Concluded wars scored" stat tile
  (`llama-dashboard/renderer/index.html`) stating plainly that attendance-based exclusion isn't
  synced here yet and pointing to the website, so the gap is visible rather than silent. Done.

- [x] **6. Self-marked-absent wars show the wrong exclusion reason.**
  `js/llama-score.js:1533` — `autoExcludeReason` returns `"player-hidden"` for both the old
  Hide/departed cutoff AND the new attendance-based absence, even though `js/app.js:866` and
  `index.html`'s tooltip text were specifically edited this session to describe the attendance case
  under `"player-departed"`.
  **Fix:** branch the reason string — `isDepartedAsOf(...)` → `"player-hidden"` (existing,
  unchanged meaning), `isAbsentDuring(...)` → `"player-departed"` (matches the edited tooltip).
  Check the enemy-side path (`enemyActivePlayer`, ~line 1521) for the same split if applicable.

- [x] **7. Unsigned-key fix covers DB entry keys, not scalar references to them.**
  `js/clausewitz.js:485-488` reads `government.ruler`/`heir`/`consort`/`regent` as plain signed
  int32s (no correction), while `character_db`'s own entry keys now get the `walkDatabase`
  unsigned fix (`js/clausewitz-binary.js:653-666`). `attachSocietalSourceFacts`
  (`js/clausewitz.js:2474-2504`) then looks up `traitsByCharacter.get(state.ruler)` — corrected key
  vs. uncorrected reference. A character ID that happens to exceed 2^31 (population keys in a real
  save reached ~2.3B from the same shared ID pool) would silently fail this lookup.
  **Fix:** add a small `unwrapDatabaseId(n)` helper next to the government-field extraction in
  `js/clausewitz.js` (same `+= 4294967296` correction, safe unconditionally since these references
  are never legitimately negative in either save format) and apply it to `ruler`/`heir`/`consort`/
  `regent`.

- [x] **8. Attendance checklist only lists the current roster.** (Fixed in the second pass, below.)
  `js/app.js:1296-1303` builds the checkbox list from `latestSnapshot.playerCountries` only. A
  player who was active earlier in the reviewed window but whose country was gone by the latest
  snapshot (conquered, merged, handed off) can never be marked absent for that stretch.
  **Fix:** `openAttendanceModal` now takes a 4th `windowSnapshots` param and unions
  `playerCountries` across every snapshot whose date falls in `[lastCheckpointDate, latestSnapshot.
  date]` (both inclusive, matching `isAbsentDuring`'s own established inclusive convention), instead
  of reading only the latest snapshot. Threaded through both callers: `maybePromptSessionAttendance`
  (via `draw()`'s in-scope `snapshots`) and the manage button (via a new `currentLlamaSnapshots`
  module var, set/cleared alongside `currentLlamaCampaignKey`/`currentLlamaLatestSnapshot` in
  `draw()`/`onParsed`/Disconnect). Exported `dateKey` from `js/llama-score.js` for the window-date
  comparison instead of writing a third copy of date-key logic.

## Plausible, lower-severity — fixing since they're small and cheap

- [x] **9. Disconnect doesn't clear the attendance modal's own campaign key.**
  `js/app.js:2066-2067` clears `currentLlamaCampaignKey`/`currentLlamaLatestSnapshot` but not the
  separate `attendanceModalCampaignKey`/`attendanceModalTargetDate` module state the Submit handler
  reads. **Fix:** clear both pairs in the Disconnect handler; close the attendance modal if open.

- [x] **10. `isValidEu5Date` accepts `"0.0.0"`, the exact sentinel it exists to keep out.**
  `js/app.js:1205-1207`. Shape-only regex accepts `0.0.0`/`0.0.0.0` (collides with `dateKey`'s
  0 fallback) and doesn't bound month to 1-12 or day to 1-31. **Fix:** after the regex/shape check,
  parse the components and reject year `0`, month outside 1-12, day outside 1-31.

- [x] **11. Prompt-dedup key uses unescaped `"|"` concatenation.**
  `js/app.js:1339` — `campaignKey + "|" + latestDate`, the same collision class this session's
  commit fixed elsewhere (checkbox name/tag). **Fix:** switch `promptedAttendanceFor` to a
  `Map<campaignKey, Set<date>>` instead of a flat joined-string Set.

- [x] **12. New save load doesn't clear the stale campaign key.**
  `js/app.js:538` (`onParsed`) nulls the ledger arrays but not `currentLlamaCampaignKey`/
  `currentLlamaLatestSnapshot`, so a click on "Who missed a session" during the async auto-link
  window can act on the previous save's campaign. **Fix:** null both alongside the ledger arrays in
  `onParsed`, mirroring the Disconnect handler.

- [x] **13. War dedup key collapses when `startDate` fails to parse.**
  `js/llama-score.js:1376` — `${warNumber}:${startDate}` becomes `${warNumber}:null` for any war
  with an unparseable start date; two such wars sharing a reused `warNumber` would merge. Narrow
  (warNumber reuse itself unconfirmed on real data) but cheap to close. **Fix:** when `startDate`
  is falsy, key on `sourceHash`/`date` instead of the literal string `"null"`.

- [x] **14. `isValidEu5Date` duplicates `js/clausewitz.js`'s `DATE_RE`.**
  Character-for-character copy of the parser's own date regex. **Fix:** export `DATE_RE` from
  `js/clausewitz.js`'s returned module object, reference `Clausewitz.DATE_RE` from `isValidEu5Date`
  instead of a second copy (semantic month/day bounds from #10 layer on top, not replacing this).

## Second pass (same day, after the user asked to continue on the two deferred items)

- [x] **8 (see above, moved up) and 15 both done.** `economicOutcomeSignal`/`inferOutcome` and
  their full dependency chain (`principalCountrySet`, `overlordFor`, `principalsWithOverlords`,
  `principalsForGold`, `principalFieldSum`, `resolveSideField`, `principalFieldUnion`,
  `reparationsSignal`, `goldLikeLean`, `revoltOutcomeSignal`, `battleLossSignal`,
  `shiftConfidence`) are now one shared, UMD-wrapped module: `js/llama-score-outcome.js`. Both
  `js/llama-score.js` and `llama-score-automatic-logging-machine/llama-log-machine.js` `require()`
  it (browser side via `root.LlamaScoreOutcome`, following `js/clausewitz-binary.js`'s existing
  cross-UMD-module pattern exactly). Pure computation, zero `fs`/`path`/Clausewitz dependency,
  confirmed by grep before extracting - the "duplicated because that file is Node-only" reasoning
  in the old website-side comment didn't actually apply once scoped to just these functions.
  **A line-by-line diff of the two pre-extraction copies (not just eyeballing) surfaced real,
  previously-invisible drift that justified doing this at all:** the recorder's copy had a
  defensive `null`-check in `reparationsSignal` the website's copy lacked; the recorder populated a
  `loserSide` field on every signal that the website's copy never did; `inferOutcome`'s signature
  differed by one parameter (`disappeared`, recorder-only, purely cosmetic - only affects a fallback
  reason string); and the recorder's version additionally returned `attackerScore`/`defenderScore`.
  All of these are strictly additive for the website consumer (extra fields it doesn't currently
  read) except one: **the recorder's final no-decisive-signal fallback never set `whitePeace: true`,
  which the website's `computeFromLedger` (`!outcome.whitePeace` at the decisiveness-continue check)
  depends on to treat that fallback as a legitimately scored White Peace row rather than an
  unscoreable one.** Using the recorder's version as the base (it was the superset) without this one
  field would have silently stopped scoring every war that falls through to that branch. Caught by
  re-reading the original website tail (`git`-free, from the pre-deletion extract) after the module
  compiled, before either consumer was rewired - fixed by adding `whitePeace: true` back into the
  shared fallback (confirmed via grep that the recorder never reads `.whitePeace` anywhere, so this
  is safe for it too).
  Also found and fixed two build-config drift risks while wiring this up: `llama-dashboard/scripts/
  prepare-vendor.js` and `llama-dashboard/package.json`'s packaging `filter` both hardcode the exact
  list of `js/*.js` files the packaged app vendors in - both had `llama-score.js` but would NOT have
  picked up the new `llama-score-outcome.js`, which would have crashed the packaged app at startup
  (`require()` failing to resolve) despite working fine in dev mode. Added it to both lists.
  **Verified thoroughly given the size of this change:** all 6 melted-save ground-truth pairs still
  0 field mismatches (parser wasn't touched, but re-ran anyway); the real-live-campaign scoring
  script (94 rows, same leaderboard numbers to the decimal, `unscoreableCount: 0`, same land-transfer
  ID-overlap spot-check results) reproduced byte-identical output before and after the extraction;
  rebuilt the local packaged dashboard test build (`npm run dist`), confirmed `llama-score-outcome.js`
  present in both `vendor/js/` and the packaged `resources/app/vendor/js/`, confirmed real campaign
  data (`data/state.json`) survived the rebuild; launched the actual packaged Electron app via CDP
  (not dev mode - the real code path that would have caught the vendor-list bug), selected the real
  campaign, checked both PVP and PVE tabs rendered real numbers with no exceptions
  (`listen` showed zero thrown errors/console errors), and confirmed the new dashboard tooltip
  (fix #5, prior pass) reads correctly in the running app.

- **16. Recorder write-order swap opens a narrow, self-healing concurrent-read race**
  (`llama-log-machine.js` ~1973). A live poller could observe a war-disappeared event before its
  snapshot lands mid-write. Self-corrects on the next poll; fixing it properly means an atomic or
  ordered-visibility write across two separate JSONL files, disproportionate to the actual risk.
  Not fixing this pass.

## Verification plan

- Re-run `test/run-binary.js` (all 6 melted-save ground-truth pairs) after the clausewitz.js
  ruler/heir/consort/regent fix (#7) — must stay 0 field mismatches.
- Sweep all real `.eu5` fixtures the repo already has for parse warnings/exceptions, same as prior
  sessions' verification standard.
- No automated test covers `llama-score.js`'s scoring functions directly — verification for #1-#6,
  #9-#13 will be manual: read the modified logic against the specific failure scenario each finding
  describes, confirm the guard now blocks it, confirm the ordinary/non-buggy case is untouched.
- Update `CHANGELOG.md` once fixes are verified, matching this project's existing entry format.
