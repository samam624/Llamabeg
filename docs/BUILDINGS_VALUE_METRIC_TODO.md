# Buildings Value metric — status

## Resolved (2026-07-30): the "17/465" gap is fixed

The user flagged that only 17 of 465 building types getting a real ducat
price "is definitely not the right data." That's now fixed - see
`[[buildings_value_metric]]` memory for the full story. Short version:

There is no single flat cost table in the game files. There are THREE
mechanisms, and the tool now handles all three correctly:

1. **Explicit `price =`** (17 buildings: cathedrals, plantations, HRE
   armory, etc.) - unchanged, resolves through `prices/*.txt`.
2. **Implicit age-tier default** (337 buildings, NEW) - confirmed via 14
   real in-game tooltip screenshots covering every combination of
   non-expensive/expensive x ages 1-3 x advance-derived/default-age-1, all
   exact matches (see `[[buildings_value_metric]]` memory for the full
   list). A building's cost is `p_building_age_N_*` or (if
   `expensive = yes`) `p_expensive_building_age_N_*` from
   `prices/01_buildings.txt`, where N is the age of whichever
   `advances/*.txt` entry has `unlock_building = <this building>` -
   or `age_1_traditions` if no advance unlocks it at all (available from
   game start; this exact fallback branch was itself confirmed via
   `naval_governor`, predicted and matched 200g). Buildings gated
   `allow`/`potential`/`country_potential = { always = no }`
   (event/decision-granted wonders - versailles, zwinger, wisselbank, ...)
   correctly stay excluded, since they're never normally constructed and
   have no real cost to infer.
3. **`construction_demand`** - confirmed NOT a cost (monthly upkeep only,
   shown separately in-game under "Requirements ... to progress"). Still
   correctly excluded.

Remaining ~111 buildings stay at `baseCost: 0` (`source:
"excluded_upkeep_only"`) - these are the true unbuildable-through-normal-
construction wonders/event buildings, a real scope limit, not a bug.

## Residual risk (mostly de-risked)

The "no advance found → default to age 1" fallback (mechanism 2 above) was
worried to risk landing a handful of buildings on a wrong age-1 default if
they're unlocked through some non-advance mechanism. `naval_governor` was
exactly this case (no advance-unlock trace, `expensive = yes`) and its
predicted 200g matched the real in-game tooltip exactly - real evidence
the fallback generalizes. Not exhaustively audited across all 170
buildings using this fallback, so if a specific building's Buildings Value
contribution ever looks wrong, still worth checking for a non-advance
unlock path before assuming the tool is wrong generally - but this is no
longer the open question it was.

## Where the code lives

- `tools/build-building-costs.js` - the extraction tool (run manually:
  `node tools/build-building-costs.js`), writes
  `game_data/building-costs.json` (gitignored). Full mechanism writeup is
  in its header comment.
- `js/app.js` - `buildingValueToLevel()`, `computeBuildingsValueByCountry()`,
  `applyBuildingsValueMetric()`, and the `buildingsValue` column in
  `COUNTRY_COLUMNS`/`COUNTRY_METRIC_GROUPS.economy`. No changes needed -
  it just consumes whatever `baseCost` the tool produces.
- `scripts/build-netlify-site.js` - bundles the JSON into `dist/` at deploy
  time if present locally.

Not yet deployed - regenerate `game_data/building-costs.json` (already done
this session) and re-verify against a real save before shipping.
