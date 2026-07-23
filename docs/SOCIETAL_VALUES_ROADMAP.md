# EU5 Societal Values tracking — spec for the Modifier Optimizer

## Status

Implemented in the desktop Modifier Optimizer. Text and binary saves capture
applicable per-country axes; the scanner derives both directional keys and
law-menu categories; and the Electron UI shows current position/impact,
monthly contributors, equilibrium ceiling, recommendations, and exact law
paths. Modifier snapshots also retain the compact dynamic facts that affect
monthly movement but are not ordinary active choices: location development
and control, population/literacy/religion/culture ratios, artwork share,
ruler traits, maintenance settings, employment system, peace/war state,
tradition, and subject counts. These are combined with active choices in
both directions before calculating the net equilibrium. The axis picker now
also exposes later-age axes before they become applicable; their advances,
laws, privileges, reforms, static sources, and `auto_modifiers` scaling
formulas are discovered from the installed game files instead of a fixed
list, so newly unlocked ages use the same scanner.

The HUN 1337.6.1 validation fixture was checked against screenshots for all
11 early-game axes. It also caught and fixed an international-organization
law error: leader-only and ordinary-member variants of the same church law
must not both be counted. Temporary event bundles remain informational and
are excluded from the equilibrium/optimization calculation.
Older ledgers automatically reparse their newest autosave once when this
modifier-state schema changes, so a newly captured autosave is not required.
**Correction (2026-07-19)**: that reparse-once mechanism had a real bug -
it only ever refreshed the single globally-newest save across the whole
watched folder, not the newest save *per campaign*, so any campaign other
than whichever was "latest" at the exact moment the schema changed stayed
stale forever. Fixed in `llama-score-automatic-logging-machine/llama-log-
machine.js`'s `scan()` - see `docs/MODIFIER_OPTIMIZER_ROADMAP.md`'s known-
limitations entry for the fix.

**Extension (2026-07-19)**: a societal axis's `left_modifier`/
`right_modifier` bonus (e.g. `aristocracy_vs_plutocracy`'s `selling_
efficiency` grant, the running example in this doc) now also counts toward
the **general** Modifier Optimizer's active-contribution total for a raw
key search (`selling_efficiency`, not just `monthly_towards_*`), not only
the dedicated Societal Values equilibrium view - `classifyDynamicSource()`
in `js/modifier-finder.js` scales it by the axis's actual current position
the same way this doc's #1 already described for the equilibrium view.
Verified against a real save: a country's Selling Efficiency total came out
to 9.90% against the game's own displayed 9.89%, correctly including its
Aristocracy↔Plutocracy contribution alongside advances and a ruler trait.
This was
originally a spec for extending the existing Modifier
Optimizer (`docs/MODIFIER_OPTIMIZER_ROADMAP.md`) — written up separately
rather than folded into that doc or built directly, specifically to avoid
colliding with in-progress edits to `tools/scan-modifier-sources.js`,
`js/modifier-finder.js`, `js/clausewitz.js`, and `llama-dashboard/`. Every
claim below was verified directly against the real game files and a real
save before writing this — file paths and field names are exact, not
guessed.

## Product goal

The user wants EU5's own **Societal Values** panel (Centralization vs
Decentralization, Aristocracy vs Plutocracy, Spiritualist vs Humanist, …)
reproduced with actionable recommendations, matching three things the
in-game UI already shows per axis (see the screenshots this spec was
written from):

1. **Current position** and the static country-modifier bonuses it's
   currently granting ("The Current Impact of 70.00 towards Aristocracy
   is...").
2. **What's currently pushing it**, broken into individual named
   contributors with their monthly point value ("Changes with +0.33
   towards Aristocracy each month due to: Land Rights +0.10, Autocracy
   +0.10, ...").
3. **Ranked, actionable recommendations** — sources NOT currently active
   that would push the value further, IN THE SAME DIRECTION the user is
   pushing — and, this is the part the user explicitly called out as
   missing from the base game's own UI: **the actual path to each one**
   (which top-level law category, which law group, which specific choice
   within it), not just a bare name you have to go hunting for.

The good news: this is not a new system. A societal value's monthly drift
is implemented as an ordinary modifier key (see below) — the exact
mechanic the Modifier Optimizer's scanner/evaluator already handle. This
should be an *extension* of that pipeline, reusing `buildModifierReport`,
`evaluateEligibility`, and the whole extraction→evaluation→presentation
split as-is, not a parallel system.

## Confirmed technical facts

### 1. Axis definitions: `game/in_game/common/societal_values/00_default.txt`

One top-level entry per axis, named `<left>_vs_<right>`:

```
aristocracy_vs_plutocracy = {
  left_modifier = { discipline = 0.1  global_nobles_estate_power = 0.50  ... }
  right_modifier = { selling_efficiency = small_trade_efficiency_bonus  ... }
  opinion_importance_multiplier = 0.5
}
```

`left_modifier`/`right_modifier` are the country-modifier bonuses granted
at full ±100 — the "Current Impact" popup interpolates these by the
current position (see #2), which is straightforward to reproduce
client-side (no game-file scanning needed for this part, just read this
one file and interpolate).

There are more axes defined than the 11 pairs shown in the user's
screenshots (e.g. `latinization_vs_hellenization`,
`sinicized_vs_unsinicized`, `absolutism_vs_liberalism`, `outward_vs_inward`
— presumably government/region/era-gated, several of which read `-999` on
a normal-government country in the real save checked below, meaning "not
applicable to this country" rather than a real position). Filter to axes
whose current value is `> -999` for a given country before showing them.

### 2. Current position: stored per-country in the save

Confirmed directly against a real save dump
(`Documents\Paradox Interactive\Europa Universalis V\oos\...\hotjoinsave_1.txt`,
~line 3241454, inside a country's `government` block, immediately after
`implemented_privileges` — same section
`js/clausewitz.js`'s `extractCountryFields` already reads other
`government.*` fields from):

```
societal_values={
    centralization_vs_decentralization=35.93954
    traditionalist_vs_innovative=11.96302
    spiritualist_vs_humanist=-100
    aristocracy_vs_plutocracy=-38.2287
    ...
    mercantilism_vs_free_trade=-999   # not applicable to this country
}
```

Range appears to be roughly -100..100. Per the axis key's own
`<left>_vs_<right>` order, a **negative** value sits toward the LEFT side
(e.g. `aristocracy_vs_plutocracy=-38.2287` means 38.2% of the way toward
Aristocracy), positive toward RIGHT. `-999` = not applicable for this
country's government/culture/era — filter these out rather than showing a
nonsense bar position.

Add to `extractCountryFields` in `js/clausewitz.js`/mirrored in the binary
parser (same `includeModifierState`-style opt-in the existing modifier
work already added), something like:

```js
societalValues: government.societal_values && typeof government.societal_values === "object"
  ? Object.fromEntries(Object.entries(government.societal_values).filter(([, v]) => typeof v === "number" && v > -999))
  : {},
```

Needs the fixed-ID for `societal_values` inside `government` (binary
parser) — not yet looked up; same byte-verification workflow the existing
`researched_advances`/`implemented_laws` IDs used
(`js/eu5-fixed-ids.js`'s comment block near line ~290).

### 3. What's pushing it: ordinary modifier keys, `monthly_towards_<left>` / `monthly_towards_<right>`

Confirmed by grep across `game/in_game/common/` (106 files reference this
pattern) and by literally running the **existing, unmodified** scanner:

```
node tools/scan-modifier-sources.js monthly_towards_humanist
```

...found real direct sources across `laws`, `government_reforms`,
`estate_privileges`, and `parliament_issues`, plus 18 indirect bundles —
zero code changes needed to get this far.

**The axis→key mapping is completely mechanical**: split the axis key on
`_vs_`. `aristocracy_vs_plutocracy` → `monthly_towards_aristocracy` (left)
and `monthly_towards_plutocracy` (right). Verified against every axis
sampled from the grep output (`centralization`/`decentralization`,
`traditionalist`/`innovative`, `serfdom`/`free_subjects`, all present as
separate `monthly_towards_*` keys). No hardcoded per-axis table needed —
derive both key names from `societal_values/00_default.txt`'s own
top-level keys at scan time.

So: for each axis a country currently has (per #2), run the scanner twice
(once per direction) — or, better, once for the axis the user picks and
only the direction they're trying to push. Everything downstream
(`classifySource`, `evaluateEligibility`, `buildModifierReport`) already
works unchanged, since none of it is `selling_efficiency`-specific — it's
generic over whatever `modifierKey` was scanned.

### 4. The "show me exactly where" requirement: `law_category`

Every law GROUP definition (`game/in_game/common/laws/*.txt`) carries a
`law_category` field, e.g.:

```
feudal_de_jure_law = {
  law_category = administrative
  law_gov_group = monarchy
  by_tradition = { country_modifier = { ... monthly_towards_inward = societal_value_monthly_move } ... }
  by_blood = { country_modifier = { ... monthly_towards_outward = societal_value_monthly_move } ... }
}
```

Full enumerated set of values actually used (`grep -rh "law_category\s*="
game/in_game/common/laws | sort -u`): `administrative`, `centralization`,
`election`, `elector`, `estates`, `federal`, `foreign_policy`,
`foundation`, `free_city`, `leadership`, `military`, `religious`,
`socioeconomic`. (The 5 the user's screenshot showed — Administrative /
Estate / Military / Religious / Socioeconomic — are just whichever of
these applied to their current government type; the others are
gated to tribes/republics/HRE-elector/etc governments.)

This is exactly the missing piece for "show the path, not just the name":
`tools/scan-modifier-sources.js`'s `matchingDefinition()` already resolves
each source hit back to its FULL parsed law-group object (needed today for
`compactEligibility()`'s `potential`/`allow`/`age` extraction) — the
`law_category` field is sitting right there on that same object, just not
being copied into the compact `eligibility` record yet. One-line addition
to `compactEligibility()`:

```js
lawCategory: folder === "laws" ? definition.law_category || null : null,
```

`government_reforms`/`estate_privileges` have **no equivalent category
field** — confirmed by grep, nothing found. Those two systems apparently
don't have the same "which of 5 sub-menus is this in" problem the user
described (matches that their complaint was specifically about laws), so
this spec doesn't propose anything extra for them. Advances are organized
by age, already a natural, easy-to-navigate grouping — same reasoning.

### 5. The "ceiling" cap: solved — it's just the monthly rate × 100

User-supplied and confirmed against all four of the screenshots this spec
was written from:

| Axis | Monthly rate shown | rate × 100 | Actual cap shown |
|---|---|---|---|
| Centralization/Decentralization | +0.26 | 26 | 26.51 |
| Aristocracy/Plutocracy | +0.33 | 33 | 33.56 |
| Capital/Traditional Economy | +0.17 | 17 | 17.43 |
| Spiritualist/Humanist | +0.28 | 28 | 28.61 |

Matches to within rounding (the displayed "+0.XX" rate is itself rounded
to 2 decimals) on all 4 independent examples. So:

```
ceiling = monthlyRate * 100
```

...where `monthlyRate` is exactly the sum of currently-ACTIVE
`monthly_towards_<direction>` sources for that direction — i.e. the same
figure `buildModifierReport` already computes as `knownActiveContribution`
once step 2 above runs the scan against that direction's key. **No new
data or separate computation needed** — once #2/#3 are wired up, the
ceiling is one multiplication away, not a mystery to reverse-engineer.
Small caveat: this is the cap toward the direction that rate is currently
pushing; a report run against the OPPOSITE direction's key would need that
direction's own active-source sum for its own ceiling — same formula,
just evaluated on whichever `monthly_towards_*` key is currently being
displayed.

## Suggested UI shape (desktop Modifier Optimizer tab)

Given a selected player country, list its non–`-999` societal value axes
(label pairs from #1, current position bar from #2). Selecting one axis +
a push direction runs the existing `buildModifierReport` machinery against
that direction's `monthly_towards_*` key, then renders exactly like the
existing modifier report (`renderModifierReport` in
`llama-dashboard/renderer/renderer.js`) with one addition: for `laws`
rows, show the resolved path — `lawCategory → folder/group entity → choice`
(e.g. "Socioeconomic Laws → Education Policy → Education of the People"),
using existing localization/prettification (`prettifyId`) until real
English-loc lookups are wired in (Phase 2 of the base roadmap already
covers real localization generally — this doesn't need its own separate
localization effort, just needs `lawCategory` threaded through once that
lands).

## Suggested delivery order

1. `extractCountryFields` + binary-parser parity: capture
   `societalValues` (per #2). Verify with a real-save text/binary parity
   probe, same gate the base roadmap already requires for every parser
   addition.
2. Enumerate axes from `societal_values/00_default.txt` at scan time;
   derive both `monthly_towards_*` key names per axis (per #3) — a small,
   generic helper, not per-axis hardcoding.
3. Add `lawCategory` to `compactEligibility()`'s output (per #4) — one
   line, `laws` folder only.
4. Desktop UI: axis picker + direction, reusing `buildModifierReport`
   unchanged; render the law path when `lawCategory` is present, and the
   ceiling as `report.knownActiveContribution * 100` (per #5).
