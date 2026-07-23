# EU5 Modifier Optimizer Roadmap

## Product goal

Add an opt-in workspace to the desktop tracker that answers: “Given the country in my latest autosave, what can I change right now to push this value?” The first target is `selling_efficiency`, but the data model is modifier-key driven so the same pipeline can later support tax, manpower, trade power, control, army quality, and other moddable values.

The optimizer must distinguish three different claims:

1. **Active** — the latest save proves this source is currently selected.
2. **Eligible now** — the game-file trigger tree proves the country can take it now.
3. **Relevant but unverified** — the source grants the modifier, but its current state or eligibility is not implemented yet.

The UI must never present category 3 as a guaranteed available action.

## Intended workflow

1. Launch the existing desktop dashboard and leave its autosave watcher running.
2. Open **Modifier Optimizer**.
3. Select one of the player-controlled countries found in the newest autosave.
4. Pick/search a modifier value (initially a raw key, later a localized catalog).
5. Review the current modifier breakdown and ranked actions.
6. Expand an action to see its effect, requirements, conflicts, costs, and the game-file source used as evidence.
7. Make the change in EU5. The next autosave refreshes the state and moves the action from candidate to active.

## Existing foundation

- `llama-score-automatic-logging-machine` already watches rotating autosaves, waits for writes to settle, and parses text/binary saves.
- `llama-dashboard` embeds that watcher and reads its compact campaign ledger.
- `tools/scan-modifier-sources.js` finds direct modifier grants and traces indirect static-modifier bundles to event, mission, decision, situation, and scripted-action grantors in a local EU5 install.
- `js/clausewitz.js` and `js/clausewitz-binary.js` provide text/binary Clausewitz parsing parity.

The previous scanner was an offline CLI only. It did not read active country choices, evaluate triggers, localize names, or connect to the desktop UI.

## Architecture

```text
EU5 autosave                         Local EU5 install
     |                                       |
recorder parser                     modifier source scanner
     |                                       |
compact player modifierState        direct grants + bundles
     |                                       |
     +------------ modifier-finder ----------+
                         |
              active / candidate / unknown
                         |
             desktop Modifier Optimizer
```

Keep three layers separate:

- **Extraction:** faithfully turn saves and game definitions into compact facts.
- **Evaluation:** resolve triggers, conflicts, costs, and deltas without UI assumptions.
- **Presentation:** explain and rank the evaluator’s evidence; never infer eligibility itself.

## Data contracts

The recorder stores this only on player-country summaries:

```js
modifierState: {
  researchedAdvances: ["trade_advance_age_of_trad"],
  laws: { maritime_law: "protect_trade_routes" },
  lawHistory: { maritime_law: { choice: "protect_trade_routes", date: "1450.1.1", days: 730 } },
  estatePrivileges: ["formal_guilds"],
  governmentReforms: ["state_sponsored_markets"],
  estateTypes: ["burghers_estate"],
  variableKeys: ["unlocked_policy_example"],
  currentTag: "BYZ",
  originalTag: "BYZ",
  governmentType: "monarchy",
  primaryCulture: "greek_culture",
  primaryReligion: "orthodox",
  societalValues: { aristocracy_vs_plutocracy: -38.2287 },
  // societalDynamics is assembled by the RECORDER (llama-log-machine.js's
  // societalDynamicFacts()), not the raw save parser - it's a post-
  // processing step over already-extracted country/location/pop data, so it
  // only exists on a recorder-produced ledger snapshot, never on a raw
  // parser result. characterTraits (ruler/heir/consort/regent trait lists)
  // lives here, not on modifierState directly - see the traits example
  // below.
  societalDynamics: {
    averageOwnedLocationDevelopment: 12.4,
    averageOwnedLocationControl: 8.1,
    characterTraits: { ruler: ["entrepreneur", "lawgiver"], heir: [], consort: [], regent: [] },
    subjectTypeCounts: { hanseatic_member: 1 },
    // ...plus population/religion/culture ratios, maintenance settings,
    // employment system, peace/war state, tradition - see
    // docs/SOCIETAL_VALUES_ROADMAP.md for the full list and why each exists.
  }
}
```

`implemented_gods` (which Hellenic/pagan gods a country has adopted - a
plain `{date, object}` history array, same shape as `implemented_laws`) was
located in the binary save (fixed ID `0x36ea`, country-level, sibling of
`government`) during 2026-07-19's omens work but is **not yet wired into
`modifierState`** - the omens feature below doesn't need it (see that
section for why), but it's a real, findable field if a future feature does.

A normalized source contains:

```js
{
  modifierKey: "selling_efficiency",
  folder: "laws",
  entity: "maritime_law",
  path: ["maritime_law", "ara_consulate_sea", "country_modifier"],
  resolvedValue: 0.025,
  rawValue: "small_trade_efficiency_bonus"
}
```

The evaluator’s eventual action result should include `state` (`active`, `eligible`, `blocked`, `unknown`), numeric `delta`, localized labels, requirements with pass/fail/unknown evidence, conflicts, costs/cooldowns, and source-file provenance.

## Delivery plan

### Phase 1 — Connected vertical slice (implemented)

- Refactor the standalone scanner into a reusable read-only module while preserving its CLI.
- Extract researched advances, implemented laws, estate privileges, and government reforms in both text and binary saves.
- Persist only the player-country choice state in new recorder snapshots.
- Add a local-game-install setting and a Modifier Optimizer tab to the desktop app.
- Rank positive inactive sources in the four tracked systems.
- Show confirmed active sources separately from untracked direct sources and categorized indirect bundles.
- Explicitly label candidates as “eligibility not evaluated.”

### Phase 2 — Definition index and localization

- Scan all supported modifiers once per game version instead of rescanning 1,600 files per clicked key.
- Cache a derived index keyed by game version, mod load order, file mtimes, and schema version.
- Read English localization and modifier formatting rules so users search “Selling Efficiency” and see `+2.5%`, while raw IDs remain available in details.
- Record source-system metadata: law group/choice, reform slot, privilege estate, advance age/category, building scope, religion, subject type, societal-value side, traits, and parliament issues.
- Detect enabled mods and apply their overwrite/load order rather than treating every definition as simultaneously active.

### Phase 3 — Trigger evaluator (“available now”; first pass implemented)

- Implemented: preserve `potential`, `allow`, age, prerequisites, estate ownership, and unlock relationships for the four choice systems.
- Implemented: three-valued pass/fail/unknown evaluation. Unknown propagates and is displayed separately instead of becoming an eligible action.
- Implemented: tag/original tag, government, date-derived age, advances, laws/reforms/privileges, law cooldown history, religion/culture/language, estates, country unlock variables, tracked-source boolean modifiers, and international-organization membership/leadership/law state.
- Remaining: preserve `visible`, `can_select`, mutual exclusions, and more scripted-trigger references during indexing.
- Implemented: applicable societal-value positions, directional definition impacts, monthly drift scans, law-category navigation paths, and the confirmed-rate equilibrium ceiling.
- Remaining country facts: broader subject relationships, dynamic merged-culture member lists, capital/location facts, religious schools, DLC and enabled-mod flags.
- Resolve scripted triggers and scripted values recursively with cycle guards and an explanation trace.
- Verify evaluator results against actual enabled/disabled buttons in several real campaigns before changing the UI label from “candidate” to “available now.”

### Phase 4 — Accurate current-value decomposition

- Locate the save’s active modifier instances/aggregates and determine which have stable source identities.
- Implemented for definitions: join static-modifier bundles back to the event/mission/decision/situation/scripted action that can grant them, including scripted duration.
- Implemented in the optimizer: event-granted bundles are temporary informational sources and are excluded from eligible actions and the player-controlled contribution calculation.
- **Implemented (2026-07-19): ruler traits and societal values now count toward `knownActiveContribution`, not just advances/laws/reforms/privileges.** Verified end-to-end against a real save (BYZ, Eastern Rome campaign): computed Selling Efficiency came to 9.90% against the game's own displayed 9.89% (rounding only), correctly attributing all four real contributors - two advances, the ruler's Entrepreneur trait, and the Aristocracy↔Plutocracy societal-value position. Ruler traits were already wired into `evaluateEligibility`/`classifyDynamicSource` (`js/modifier-finder.js`) from earlier work; societal-value sources are new - `classifyDynamicSource` now checks the source's `left_modifier`/`right_modifier` side against the country's actual current axis position and scales linearly (±100 = full strength), the same interpolation the in-game "Current Impact" popup uses (see `docs/SOCIETAL_VALUES_ROADMAP.md` #1).
- **Implemented (2026-07-19): religious omens/gods surfaced as a new candidate category ("Omens"), deliberately NOT counted toward the active total.** EU5 lets a country favor one god per ability (ADM/DIP/MIL) and pick one of that god's omens; which omen is *currently selected* could not be located in the save (checked the government block, all country-level fields, the top-level `religion_manager` section, and the global string table - see `reverse-engineer-eu5-binary-field` skill for the methodology and what didn't pan out). Every omen the country's actual primary religion could grant is shown as an unverified "eligible" candidate instead, labeled "current selection not tracked, may already be active" - never claimed as a proven, non-redundant recommendation the way a law swap is. `implemented_gods` (which gods are unlocked) was found in the binary format but turned out unnecessary for this: EU5 unlocks all of a religion's gods simultaneously (confirmed real: BYZ's 6 Hellenic gods all show the same unlock date), so the religion match alone is a sufficient (and simpler) gate.
- Remaining: locate the save's currently active modifier instances so informational bundles can be labeled active/inactive rather than merely possible, AND so the *currently selected omen* specifically can be marked active instead of listed as an unverified candidate.
- Add building, parliament, temporary modifier, and difficulty sources (religion/omen and ruler-trait sources are now implemented - see above).
- Show “known contribution” until extracted sources reconcile with the in-game displayed total within a defined tolerance; only then call it “current total.”
- Preserve duration/expiry and conditional scope so a temporary bonus is not presented as permanent.

### Phase 5 — Optimization engine

- Model mutually exclusive choices and slot limits instead of summing incompatible bonuses.
- Rank by user-selected objective: largest immediate delta, cheapest change, shortest time, lowest political cost, or best multi-stat package.
- Support prerequisite chains (for example, research A before reform B) and show the ordered action path.
- Add “protect these values” constraints to avoid recommending a selling-efficiency gain that destroys another chosen stat.
- Use exact search for small choice sets and bounded branch-and-bound/beam search for large combinations; always return an explanation, not only a score.

### Phase 6 — Production hardening

- Move indexing/evaluation off Electron’s main process and stream progress/cancellation to the renderer.
- Add schema/version guards for old ledger snapshots and cached indexes.
- Add fixtures for multiple EU5 patches, text/binary parity, mod overrides, missing DLC, corrupted/truncated autosaves, and unknown tokens.
- Add privacy-safe diagnostics that export only derived facts and evaluator traces, never copyrighted game files or personal saves.
- Rename the desktop product once the optimizer is broader than the Llama Score dashboard, while keeping one shared watcher process and ledger.

## Ranking rules for the first slice

- Only resolved positive values are ranked when the user wants to push a value upward.
- Confirmed active sources are removed from the candidate list.
- Candidates sort by modifier delta descending, then system and source ID for stable output.
- Law candidates show the current choice they would replace.
- No candidate is called “available” until Phase 3 evaluates its triggers.
- No total potential gain is displayed because laws, reforms, privileges, and prerequisites may be mutually incompatible.

## Verification gates

Each parser addition must pass a real-save text/binary parity probe. For at least one player country, record concrete counts and known IDs for all four choice systems. The desktop packaging check must prove the scanner, finder, parser, and fixed-ID table are vendored. Before “available now” ships, compare recommendations against in-game controls for multiple countries and patches, including at least one blocked country-specific source and one mutually exclusive law choice.

## Known limitations of the current build

- Old ledger snapshots do not contain all eligibility facts; one newly recorded autosave is required. **Fixed 2026-07-19**: the recorder's one-time "refresh modifier-state schema" pass used to pick only the single globally-most-recent save across the whole watched folder, silently leaving every OTHER already-recorded campaign stuck on old schema data forever (`campaignMode: "latest"` only ever watches one campaign's files at a time, so those other campaigns' saves were never even in scope to re-check). It now finds and refreshes the latest already-known save *per campaign* in one pass (`llama-score-automatic-logging-machine/llama-log-machine.js`'s `scan()`) - confirmed fixing two real, separately-stale campaigns in one tick without needing a fresh autosave from either.
- Generic modifiers still use a raw key; societal values have a game-definition-driven axis and direction picker. A plain-English search/autocomplete over the raw-key field was added 2026-07-18 (`tools/scan-modifier-sources.js`'s `scanModifierCatalog()`, reading the game's own `modifier_types_l_english.yml`) so this is less of a practical barrier than it used to be.
- Common eligibility triggers and law cooldowns are evaluated. Unsupported triggers are explicitly shown as unknown; action costs, reform slots, privilege capacity, DLC, and mod load order are not yet evaluated (one narrow, deliberate exception: a god's omen's redundant `has_dlc` check is stripped since reaching it already implies the DLC - see Phase 4's omens note).
- Buildings and other manager-level/current conditional sources are listed as untracked.
- Indirect bundles are traced and categorized by their grantors. The save parser does not yet identify which event/mission/scripted bundles are active on the selected country.
- Event-granted bundles are displayed as temporary/informational and excluded from recommendations and optimizer totals; non-event scripted bundles also remain informational until their action rules are modeled.
- The confirmed active contribution now also includes ruler traits and societal-value positions in addition to the four tracked choice systems (as of 2026-07-19 - see Phase 4), but is still not the full in-game value (buildings, parliament, temporary modifiers, and difficulty are still missing).
- The desktop UI split the combined "Modifier Optimizer" tab into two top-level tabs (2026-07-19): **Value Optimizer** (societal-value axis/direction picker) and **Modifier Optimizer** (raw/plain-English key search), each with its own country selector, results panel, and status note.
