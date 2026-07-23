---
name: diagnose-eu5-binary-parser-desync
description: Find why a real EU5 binary save parses to suspiciously empty or wrong data (0 players/wars/locations, a country field that's always undefined, etc.) with NO thrown error - a silent desync, not a crash. Use whenever a real save "just doesn't work" on the website/recorder despite parsing without exception, especially a large/long/multiplayer save that a short solo reference save never exercised.
---

# Diagnosing a silent EU5 binary parser desync

A **crash** is the easy case - `result.parseWarning` (js/clausewitz-binary.js) already gives
you the exact byte offset and error message; skip straight to Step 3 below. This skill is for
the harder case: the parse **completes with no error at all**, but some result is obviously
wrong (0 players in an 8-player campaign, 0 wars, a suspiciously small location count) - the
walk desynced silently and kept going, producing plausible-looking garbage or empty data
instead of throwing. This happened for real on 2026-07-23: 25 straight autosave snapshots in
a live campaign looked like clean "no activity" recordings and weren't caught for hours.

## Step 0: is this actually new, or a known-obsolete bug class?

As of 2026-07-23 the parser is a two-phase "tape" design (see
`docs/ARCHITECTURE.md`'s "Binary parser" section) - phase 1 tokenizes the whole buffer with
zero shape assumptions (byte-width is always self-describing from a token's own type tag),
phase 2 walks that tape by index. This structurally rules out the bug class that used to cause
silent desyncs from a wrong *shape* assumption (e.g. "the top level is always key=value").
If you're looking at a fresh bug, it's more likely one of:
- a genuinely new/unmapped **value-type code** (see Step 4 - jomini cross-check), or
- a wrong assumption in exactly ONE section parser's own logic (misreads that section, but
  can't corrupt anything downstream anymore - narrows the search a lot).

`test/debug-desync*.js`/`test/debug-anomaly-scan.js` predate this rewrite and assume `dec.pos`
is a byte offset (it's a tape index now) - don't trust them as-is, they need adaptation.

## Step 1: reproduce directly, bypassing the app

Use `test/run-binary-solo.js` (no melted-save pair needed) against the real problem save,
with the SAME options production actually uses (`includeWars`/`includeLocations`/
`includeModifierState: true` - the default-opts test can pass while the real recorder still
fails, since more sections get walked with all three on):

```bash
node test/run-binary-solo.js "path/to/real.eu5"
```

Confirm the shape of the failure: which counts are 0/wrong, does `parseWarning` fire (it might
now, since this field didn't always exist - check the parser actually being used is current).

## Step 2: find where in the file the wrong section starts

Reuse the top-level-key-listing pattern (adapt for tape indices, not byte offsets, if working
against the current architecture): walk top-level `gamestate` entries one at a time, printing
`key`/`pos`/size, comparing against a **known-good reference save's** listing for the same
game version. The two should have the same top-level key set (order can differ) - a save that
never reaches an expected key (`war_manager`, `played_country`, `locations`, ...) that a
working save has tells you the desync happens *before* that point, not that the key doesn't
exist this campaign.

## Step 3: bisect the suspect section's own children

Once you've narrowed to one top-level section (e.g. `diplomacy_manager`, `locations`), don't
guess - walk ITS immediate children one at a time with the tape cursor (`dec.peekKind()`/
`dec.resolveToken()`/`dec.skipBareValue()`), checking after each one that the cursor lands
somewhere plausible (next child's key resolves cleanly, or the section's own CLOSE). This
finds the exact entry that desyncs, not just "somewhere in this 100MB section." `test/
debug-desync3.js`'s structure (fast-forward to an entry index, then debug-trace just that one)
is the right shape even though its byte-offset semantics are stale now.

**Key lesson from 2026-07-23**: a section closing at exactly the byte count you expect does
NOT prove everything inside it decoded correctly - a byte-width bug can drift alignment
mid-section and still coincidentally re-balance OPEN/CLOSE nesting by the time the section
ends, especially in a highly repetitive structure (many similar per-country/per-pop records).
Bisect the *children*, don't just trust the outer boundary.

## Step 4: cross-check against jomini's catalog for a missing/misrouted value-type code

If Step 3 finds the exact desync point, check what 2-byte code is actually sitting there and
compare it against [jomini's binary token catalog](https://github.com/rakaly/jomini)
(`src/binary/lexer.rs`, or ask for `BinaryToken` enum variants + their hex codes) - this is
the reference implementation PDX Tools itself uses, and its catalog is complete/verified. This
found 5 real missing codes in one pass on 2026-07-23 (`I64` `0x0317`, `F32` `0x000d`, 3/4-byte
`string_lookup` refs `0x0d41`/`0x0d3f`, empty-string `0x0d42`) - all silently treated as
"unresolved token, zero payload" before, which is exactly how an 8-byte value gets
under-consumed by 8 bytes and desyncs everything after it (same mechanism as the older-known
`0x029c` bug, `docs/ARCHITECTURE.md` has the full writeup).

**Gotcha discovered the hard way**: `0x0001`/`0x0003`/`0x0004` (EQUALS/OPEN/CLOSE) are not
*exclusively* structural - the format also reuses them as bare opaque enum values in specific
fields, reached only via the "read this as a bare value" path (never via the "is the next
token EQUALS/OPEN/CLOSE" structural checks, which always explicitly test for them first).
If you're writing/fixing a decoder's value-resolution fallback, all three must degrade to the
same `{fixedNum: code}` sentinel every other unmapped code gets - not throw or special-case
them as always-structural. Byte-verified in a real save's `population.database.pop_demand`
array (a literal EQUALS-coded array element with no key before it) and elsewhere with CLOSE.

## Step 5: verify the fix doesn't regress anything

Non-negotiable before considering a fix done - `test/run-binary.js` against **every** melted-
save pair in `melted_saves/` (see `test_save_data` memory for the list), not just the save
that was broken:

```bash
for f in save\ games/autosave_*.eu5; do :; done  # match by UUID against melted_saves/
node test/run-binary.js "save games/autosave_<uuid>.eu5" "melted_saves/autosave_<uuid>_melted.eu5"
```

Zero field mismatches on all pairs = the fix is real, not a coincidental fix for one save that
broke something else. This is how the 2026-07-23 rewrite caught its own EQUALS-as-value bug
before shipping - the fix that "obviously" made the broken save parse also needed to NOT
change output on the 6 already-passing reference saves, and initially didn't until the
control-code fallback was corrected.

## Gotchas

- A save that "looks fine" (parses without throwing, plausible country count) can still be
  fully desynced from some point onward - always check counts you have ground truth for
  (known player list, known active-war count), not just "did it throw."
- Don't trust a section's own outer CLOSE landing at the expected byte position as proof of
  correctness (see Step 3) - it's necessary, not sufficient.
- A short/solo reference save will never exercise every code path a long multiplayer campaign
  does (bigger `string_lookup`, wider counters, more accumulated history records). Absence of
  a bug in the standard test fixtures is not proof of absence in production.
