# Production Efficiency and Additional Metrics

This document describes the save provenance, calculation rules, UI behavior, and known
limits for the Building Production Efficiency, Literacy, and Trade Capacity metrics. It
also records the settlement split used by the production-efficiency mapmodes.

## Building Production Efficiency

Europa Universalis V does not serialize the already-computed green Production Efficiency
percentage shown in a building tooltip. The save does contain enough economic state to
estimate it for an operating building:

- `building_manager.database.*`: building type, constructed level, employed workforce,
  location, owner, `last_months_profit`, and selected production-method blocks;
- `locations.locations.*`: market number, market access, and settlement `rank`;
- `market_manager.database.*.goods`: current prices for the method's input and output goods;
- `game_data/production-methods.json`: compact input/output recipes generated from the local
  EU5 installation by `tools/build-production-methods.js`.

For every resolvable selected method, `js/additional-metrics.js` calculates on the same
full-active-level basis as the save's normalized profit:

```text
scale      = constructed building levels * location market access
gross      = output amount * scale * output market price
input cost = sum(input amount * scale * input market price)
efficiency = (last_months_profit + input cost) / gross - 1
```

The result is an estimate rather than a serialized modifier list. `last_months_profit` is a
saved completed-month value while market prices/access are the current snapshot, so small
differences from a freshly opened in-game tooltip are expected.

### Why employment is not the scale

EU5's saved `last_months_profit` is normalized to the building's fully staffed active
levels. Scaling the goods flow by current employment and comparing it with that normalized
profit creates enormous false values for under-employed buildings.

The real 1545-01-01 campaign save demonstrated this in Lavenham. Its level-1 Charcoal Kiln
had only 0.11668 of its 1.0 workforce but retained `last_months_profit = 0.41725`. Using the
staffed fraction produced a false +298.10%; using one full active level produced +17.89%,
close to the in-game +18.35%. Combined with Lavenham's +17.57% Market Village, the corrected
location average is +17.73%, not +157.8%.

### Why shortage-affected buildings are excluded

The selected production-method block can include a `missing` goods snapshot, but that
current shortage is not on a compatible time/basis with normalized last-month profit.
Combining the two fabricated Shaharah's former map maximum:

```text
Market Village inferred value: +416.93%
Farming Village inferred value:  +5.21%
level-weighted location average: +279.69%
```

The Market Village had 98.6% of its iron input unfulfilled, reducing the old calculation's
gross denominator almost to zero while its positive saved profit remained. The application
now excludes any building whose active production method has a positive shortage amount.
It does not clamp the resulting location value to hide this error.

Other exclusions are empty/unemployed buildings, missing profit, missing/unknown production
methods, missing market prices, and methods without a resolvable positive input/output
basket. Map tooltips report only the eligible building and level counts used in that value.

## Rural and urban comparisons

Production efficiency is split by the location's saved rank:

| Comparison | Included location ranks |
| --- | --- |
| Rural | `rural_settlement` |
| Urban | `town`, `city`, `megalopolis` |

Rank-less water and impassable records belong to neither group. This is a location
classification, not a building-type classification: every eligible producing building in a
rural settlement contributes to the Rural value, while every eligible producing building
in an urbanized location contributes to the Urban value.

Within a location and country, averages are weighted by constructed building levels:

```text
average = sum(building efficiency * building levels) / sum(building levels)
```

The Economy map menu exposes separate **Rural Production Efficiency** and **Urban Production
Efficiency** modes. Each mode has its own world (or focused-country) color scale and renders
the other settlement group as neutral/no data. The Players and Countries Economy tables
likewise expose separate **Rural Avg Prod. Eff.** and **Urban Avg Prod. Eff.** columns.

Real-save validation against EU5 1.3.11, date 1545-01-01:

- 38,690 eligible building records across 10,189 locations;
- 7,601 rural locations across 638 countries;
- 2,588 urban locations across 478 countries;
- rural range: -68.95% to +118.09%;
- urban range: -49.54% to +86.41%;
- Lavenham (`rural_settlement`): +17.73% across two eligible building levels.

## Literacy

Literacy is read from top-level `population.database` records, not from the summarized
population class rows stored on a location. `extractPopFields()` retains only the compact
fields required by the UI, including pop ID, size, and literacy. A location joins its
`popIds` to those records and calculates:

```text
location literacy = sum(pop literacy * pop size) / sum(pop size)
```

The country value repeats the same population-weighted calculation across pops in every
location currently owned by that country. The save already stores literacy in percentage
points (`38` means 38%), so it must not be multiplied by 100. Literacy appears on both the
Key and Demographic player/country metric groups.

## Trade Capacity

Trade Capacity is country-specific but serialized inside each market's merchant entries:

```text
market_manager.database.<market>.merchant = {
  country = <country id>
  capacity = <capacity in this market>
  used = <used capacity in this market>
}
```

`extractMarketFields()` retains compact `{country, power, capacity, used}` merchant rows.
The national metric sums a country's `capacity` across every market in which it has a
merchant; `used` is also retained and summed as `usedTradeCapacity` for future UI use.
Trade Capacity appears in the Economy player/country metric groups.

## Frozen player names

The wide Players metric table opts into `stickyFirstColumn`. Its player-name header and
cells use CSS `position: sticky; left: 0`, with an opaque surface and raised header z-index,
so names remain visible while the metric sheet scrolls horizontally.

## Data and cache path

Both text and binary saves use the shared compact extractors in `js/clausewitz.js`.
`js/parse-worker.js` posts `locations`, `popRecords`, `buildings`, and `markets` to the main
thread. `js/app.js` calls `AdditionalMetrics.applySaveBackedMetrics()` and then
`applyProductionEfficiency()` after loading the derived production-method table.

Cached parsed saves are guarded for missing population records and building
production-method records. Browser asset version `v1.3.19` ensures the rural/urban
aggregation and map code replace older cached JavaScript even when the underlying parsed
save schema is still compatible.

## Regression checks

Run:

```powershell
node test/additional-metrics.js
node --check js/additional-metrics.js
node --check js/map.js
node --check js/app.js
npm.cmd run build
```

For release verification, also parse a real compressed `.eu5` with
`includeLocations: true`, apply `game_data/production-methods.json`, and verify at least one
rural and one urban UI-facing row. Synthetic formula tests alone do not validate save-field
semantics.
