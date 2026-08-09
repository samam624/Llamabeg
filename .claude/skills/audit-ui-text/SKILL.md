---
name: audit-ui-text
description: Find and fix stale/verbose tooltips, help text, and in-app copy across the website (index.html, js/) and the Llama Score Dashboard (llama-dashboard/renderer/) after a feature changes - and the matching check for dead one-off test/debug scripts. Use whenever a feature's behavior changed and its UI text might not have been updated to match, when asked to "clean up stale text/tooltips," or periodically as a general UI-copy audit.
---

# Auditing UI text for staleness

This app explains itself to the user a lot - hover tooltips on every metric
column, `<details>` walkthroughs, dialog copy, auto-exclude reason badges.
That text is hand-written prose describing *how the code currently works*,
which means every time the code changes, the prose describing it can quietly
become wrong. Nothing enforces the connection between them. This skill is the
repeatable process for finding and fixing that drift, learned from a full
pass done 2026-07-31 (see `[[audit_ui_text_2026_07_31]]` memory for what that
pass actually found and fixed).

## Where UI text actually lives (the full map)

**Website** (`index.html` + `js/*.js`):
- `index.html` - static prose: the header subtitle, the "Llama Score User
  Manual" `<details>`, the "How are these scores calculated?" `<details>`
  (GP Score / War Score / How a winner is decided / White Peace / auto-badge
  reasons - the single densest block of explanatory text in the whole app),
  dialog/footer copy.
- `js/app.js`'s `COLUMN_DESCRIPTIONS` object (search for that exact name) -
  every metrics-table column header's hover tooltip, keyed by column key.
  This is the single largest tooltip collection and the one most likely to
  drift when a metric's calculation changes.
- `js/app.js`'s war-scoring reason lookups, all within ~100 lines of each
  other: `AUTO_EXCLUDE_TITLES`, `LLAMA_REASON_LABELS`/`LLAMA_REASON_TOOLTIPS`,
  `CONTRIBUTING_FACTOR_LABELS`, `LLAMA_MODE_COPY` (PVP vs. PVE copy pairs).
- `js/map.js` - each mapmode's `note:` field (legend text) and the location/
  country/market detail-panel prose.
- `js/charts.js` - the couple of chart hint/legend strings.

**Llama Score Dashboard** (`llama-dashboard/renderer/`):
- `index.html` - static intro paragraphs for each tab, the Fix
  players/Campaigns/Settings dialog copy.
- `renderer.js`, near the top of the file - the exact same *family* of
  lookup tables as `js/app.js`: `REASON_LABELS`, `REASON_TOOLTIPS`,
  `AUTO_EXCLUDE_TITLES`, `CONTRIBUTING_FACTOR_LABELS`, `WAR_TYPE_LABELS`.
- `renderer.js` further down - the Value Optimizer / Modifier Optimizer
  result-rendering template strings (`modifierStateNoteText`, the
  contribution-note builders, the collapsed-`<details>` blurbs).

**Cross-app coupling - the #1 trap.** `js/app.js`'s `AUTO_EXCLUDE_TITLES`
and `llama-dashboard/renderer/renderer.js`'s `AUTO_EXCLUDE_TITLES` describe
the *same* underlying reason codes (both read `js/llama-score.js`'s
`autoExcludeReason` output) and are explicitly commented in the dashboard
copy as "kept in sync deliberately." Editing one without grepping for the
other creates a *new* inconsistency instead of fixing an old one. Same
applies to the reason-label/contributing-factor tables. **Before editing any
of these, grep the sibling file for the same object name and check both.**

## The staleness-detection method

Hand-written prose has no compiler to catch drift, but this repo has three
things that (mostly) *do* stay current and can be used as ground truth:

1. **`CHANGELOG.md`** - dated, most-recent-first, describes real shipped
   behavior changes in detail, often naming the exact tooltip/column
   affected.
2. **`docs/ARCHITECTURE.md`** - the technical deep-dive, updated same-day as
   the features it describes (check its own internal dates), including
   explicit "Not yet deployed to production" markers when a feature exists
   in code/localhost but hasn't reached the live site yet. This is the most
   reliable single source for "what does this metric actually compute right
   now."
3. Feature-specific docs when they exist: `docs/STATE_TRADE_AND_TAX_INCOME.md`,
   `docs/MODIFIER_OPTIMIZER_ROADMAP.md`, `docs/SOCIETAL_VALUES_ROADMAP.md`.

**Process:**
1. Read `CHANGELOG.md`'s most recent entries (everything since the last
   audit, or just skim headings if unsure) to see what actually changed.
2. For each changed feature/metric, grep its name or column `key` across
   both UI surfaces (the file map above) - `Grep -i "<feature name>"` across
   `index.html`, `js/app.js`, `js/map.js`, `llama-dashboard/renderer/*`.
3. Read the *current* tooltip text next to the *current* `docs/ARCHITECTURE.md`
   section (or the render function's own code, if no doc section exists) and
   check: does the tooltip still describe what the code does *today*, not
   what it did when the tooltip was written?
4. A tooltip is stale if it describes a narrower/different scope, an old
   formula, a removed feature, a since-reverted UI interaction, or a "not
   yet built" caveat for something that has since shipped. It is merely
   *verbose* (a separate, lower-priority problem) if it's accurate but says
   it in three sentences where one would do.
5. Fix stale text for correctness first. Only then, tighten verbose-but-
   accurate text (see style rules below) - don't let a style pass block on
   or get confused with a correctness pass.

**Concrete example of what a stale tooltip looks like** (found and fixed
2026-07-31): `COLUMN_DESCRIPTIONS.buildingsValue` said "Ordinary economic
buildings (workshops, temples, guild halls, ...) are NOT included" - true
when only 17 of 465 building types had a resolvable price, false the moment
the 2026-07-30 age-tier-default fix brought coverage to 354/465 (see the
CHANGELOG entry and `docs/ARCHITECTURE.md`'s "Buildings Value" section). The
tooltip kept describing the *old, narrower* implementation after the code
changed underneath it - nothing broke, nothing errored, it just quietly lied
to every user hovering that column. This class of bug (coverage/scope
expands, tooltip still describes the old limit) is the single most common
staleness pattern in this codebase - specifically check every tooltip that
mentions a scope limit, an exclusion list, or a "not yet" caveat.

## Tooltip style rules (established 2026-07-31, keep new edits consistent)

- **Prefer a real equation over a prose description** whenever the code
  actually computes one. `efficiency = 1 − actualUpkeep / expectedUpkeep`
  beats a paragraph describing the same ratio in words. Look at the
  computing function itself (not just the old tooltip) to write the
  equation correctly.
- **One sentence, occasionally two.** Cut restatement and throat-clearing
  ("this represents...", "this shows how..."). Keep the one genuinely
  load-bearing caveat (why a value might read blank, a real scope limit, a
  "this differs from the in-game panel because X" note) - don't strip
  caveats that prevent real user confusion, just the padding around them.
- **Plain-text `title="..."` tooltips use raw Unicode math glyphs** (`×  ÷
  Σ  −  →  ≈  ·`), not HTML entities - they render as literal text, not
  HTML. **HTML-rendered blocks** (the `<dl>` inside index.html's `<details>`)
  use HTML entities (`&times;`, `&divide;`, ...) and `<code>` for formulas,
  matching the existing GP Score/War Score entries there.
- A tooltip wording fix alone doesn't need a `CHANGELOG.md` entry (it's not
  a behavior change). If the audit turns up a case where the *underlying
  feature* also drifted, that's a real bug - fix and changelog it separately
  from the text pass.

## Companion check: dead one-off test/debug scripts

The same "nothing enforces staying current" problem applies to `test/`'s
one-off `debug-*.js` investigation scripts - a script written to chase one
specific bug is often never deleted once the bug ships. Don't assume old =
dead, though: some of these are cited by name as *provenance* in production
code comments (e.g. `js/eu5-fixed-ids.js` cites `test/debug-war-name.js` and
`test/debug-war-reparations.js` as the derivation record for specific fixed
IDs) or in an active skill's methodology - deleting those orphans a doc
reference elsewhere. Before deleting anything under `test/`:

1. `Grep` the *entire* repo (not just `test/`) for the filename, with no
   path restriction - check production source comments, skill files, and
   `docs/*.md`, not just other test files.
2. Zero hits anywhere except the file's own header comment → safe delete
   candidate (the investigation is done and its result already shipped
   elsewhere).
3. Any hit in production code/docs/skills → keep, it's serving as a citation
   even though it never runs.
4. `docs/ARCHITECTURE.md` sometimes records an explicit prior decision to
   keep a stale-but-documented script as "historical reference for the
   technique" (e.g. the pre-tape-rewrite `debug-desync*.js` family) - respect
   that recorded decision rather than silently overriding it.
5. Batch file deletions are a destructive action - confirm the specific file
   list with the user before running `git rm`, even though it's git-
   recoverable.

The same "cited anywhere as provenance → keep" test applies to superseded
planning/status docs (`docs/*_TODO.md`, `docs/*_FIX.md` style files): if
`docs/ARCHITECTURE.md` or `CHANGELOG.md` has since absorbed the same content
in a more complete and more current form, the standalone doc is a second,
drifting source of truth rather than a useful artifact - delete it rather
than leave both around.
