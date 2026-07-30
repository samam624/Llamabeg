# Buildings Value metric — status & what to check next

## Current state (2026-07-30, shipped to code but NOT deployed)

Implemented and verified working end-to-end (real save, real browser, zero
console errors) — see `[[buildings_value_metric]]` memory and
`tools/build-building-costs.js`'s header comment for the full writeup. But
the user flagged, correctly, that only **17 of 465 building types** ending
up with a real ducat price "is definitely not the right data" — picking
this back up is the next thing to do before trusting/shipping the metric.

## The concern

`tools/build-building-costs.js` currently only assigns a nonzero `baseCost`
to a building type if it has an explicit `price = <name>` field in
`building_types/*.txt`, resolved through `prices/*.txt`. Confirmed by the
user: `construction_demand` (the OTHER mechanism, which covers ~427 of the
465 types) is a monthly upkeep rate, not a purchase cost, so it's correctly
excluded — that part isn't in question. What's in question is whether
those ~427 (plus a handful more with neither field) are genuinely FREE to
build, or whether there's a THIRD cost mechanism this tool hasn't found yet.

## The strongest lead, not yet followed

Every building type in `building_types/*.txt` can set a boolean
`expensive = yes` flag — confirmed via a directory-wide grep: **~168
occurrences** across most of the building_types files (capital_buildings,
culture_buildings, event_only_buildings, forts, market_buildings,
town_buildings, unique_buildings, etc.) - roughly 10x more common than the
17 buildings with an explicit `price =`. This strongly suggests `expensive`
combines with something else (most likely the building's age/tier) to
select an IMPLICIT default price from the very set of scripted values this
tool already resolves for the `p_building_age_1_traditions` /
`p_expensive_building_age_1_traditions` family (see
`prices/01_buildings.txt` lines ~78-121) - those looked "unused" during
the first pass (zero literal `price = p_building_age_...` references
anywhere in `building_types/`), but that's exactly what you'd expect if
they're applied as a DEFAULT rather than referenced explicitly per
building. This was not confirmed - it's the next thing to check, in order:

1. Find whatever determines a building's "age"/tier (a `category`? an
   `age_X_...` flag? something on the `possible_production_methods` chain?)
   and see if `expensive = yes/no` + that age cleanly maps to
   `p_building_age_N_*` / `p_expensive_building_age_N_*` for building types
   that currently resolve to `baseCost: 0`.
2. If that mapping doesn't hold, check whether the game's actual in-game
   "Build" menu shows a ducat cost for an ordinary building at all (e.g.
   temple, workshop) - if it shows a real number, that's proof a real
   mechanism exists and hasn't been found yet; if it shows nothing/"free",
   the current 17-of-465 scope might be correct after all and the user's
   instinct, while reasonable, would turn out not to change the outcome.
3. Either way, do NOT re-try treating `construction_demand` as a cost
   again - that's the specific mistake already made and corrected this
   session (see the memory file for why the math didn't add up).

## Where the code lives

- `tools/build-building-costs.js` - the extraction tool, run manually
  (`node tools/build-building-costs.js`) against the local Steam install,
  writes `game_data/building-costs.json` (gitignored).
- `js/app.js` - `buildingValueToLevel()`, `computeBuildingsValueByCountry()`,
  `applyBuildingsValueMetric()`, and the `buildingsValue` column in
  `COUNTRY_COLUMNS`/`COUNTRY_METRIC_GROUPS.economy`.
- `scripts/build-netlify-site.js` - bundles the JSON into `dist/` at deploy
  time if present locally.

None of this needs to change structurally to fix the `expensive`/age
question - only `buildBuildingCosts()`'s cost-resolution logic in the tool
would need a new branch, and the JSON would need regenerating
(`node tools/build-building-costs.js`) once that's sorted out. Not deployed
yet - `game_data/building-costs.json` is gitignored and nothing user-facing
has shipped.
