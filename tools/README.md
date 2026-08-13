# tools/

Data-prep and local game-install scanning scripts. Two categories:

- **Map data prep** (`build-location-data.js`, `bake-location-id-map.py`,
  `bake-home-hero.js`) - documented in the root README's "Map setup".
- **Game-install scanners** (`scan-modifier-sources.js`,
  `build-building-costs.js`, `build-production-methods.js`) - read directly from
  a local EU5 Steam install to answer questions the save file alone can't
  (e.g. what grants a given modifier). Read-only: never write into the game
  install.

## scan-modifier-sources.js

Finds every place in the game's own design files that grants a given
modifier key - e.g. `selling_efficiency` - across advances/technologies,
buildings, estate privileges, government reforms, laws, parliament issues,
religions, gods, societal values, subject types, and traits, plus a second
tier of named modifier *bundles* (granted indirectly by events/missions/
decisions rather than a direct player choice).

```
node tools/scan-modifier-sources.js selling_efficiency
node tools/scan-modifier-sources.js some_other_key --root="D:\Games\Europa Universalis V"
```

Defaults to the Steam install path
(`C:\Program Files (x86)\Steam\steamapps\common\Europa Universalis V`);
pass `--root` if installed elsewhere. Output goes to
`game_data/modifier-sources/<key>.json` (gitignored - see below) plus a
console summary grouped by source system.

Reuses `js/clausewitz.js`'s `Scanner` (the same block parser both save
formats use) rather than a second one, since the underlying Clausewitz
block syntax is identical between save files and game design files - the
only real difference is `#` comments, stripped first the same way
`build-location-data.js` already does for `definitions.txt`. Named
scripted-value tokens (`small_trade_efficiency_bonus` etc.) are resolved to
real numbers via `game/main_menu/common/script_values/`.

Comparison-operator trigger lines (`some_value > 5`, used inside
`potential`/`allow`/`limit` blocks) are *not* mistaken for a grant - the
reused Scanner only recognizes `key = value` as a named entry; anything
followed by a non-`=` operator falls through as a stray positional item
instead, so trigger-only mentions of a modifier key never produce a
false-positive "source" here.

The desktop dashboard's **Modifier Optimizer** now consumes this scanner
directly and cross-references advances, laws, government reforms, and estate
privileges against newly recorded player-country snapshots. It deliberately
calls inactive matches *candidates*, not *available actions*: evaluating the
game definitions' `potential`/`allow`/scripted-trigger trees is a later phase.
Resolving who grants each indirect bundle (event/mission/decision/situation)
is also not built yet. See `docs/MODIFIER_OPTIMIZER_ROADMAP.md`.

## campaign-ledger-doctor.js

Inspects and safely repairs a recorder campaign ledger. Mutating commands are
dry runs unless `--yes` is supplied, and every real change first backs up the
campaign ledger and `state.json`. Stop the dashboard/recorder before applying
a change.

```
node tools/campaign-ledger-doctor.js list <campaign-key> --data-dir <data-dir>
node tools/campaign-ledger-doctor.js remove <campaign-key> --after <date> --data-dir <data-dir>
node tools/campaign-ledger-doctor.js remove <campaign-key> --hash <hash-prefix> --data-dir <data-dir>
node tools/campaign-ledger-doctor.js repair-state <campaign-key> --data-dir <data-dir>
node tools/campaign-ledger-doctor.js promote <campaign-key> --hash <hash-prefix> --data-dir <data-dir>
```

`remove` also rewinds the campaign's last tracked date, active-war baseline,
last-snapshot pointer, and affected archive checkpoints in `state.json`. The
discarded save remains in the recorder's seen-file/hash cache so restarting the
dashboard cannot immediately import it again. `repair-state` rebuilds those
live baseline fields from the newest valid ledger snapshot without changing
the snapshot or event history.

## game_data/ (gitignored)

All install-derived extraction lands in `game_data/` at the repo root and is
never committed, same treatment as `map_data/`'s raw Paradox files. Raw
scanner output is not deployed. Two compact numeric transforms are the
deliberate exceptions: `building-costs.json` and `production-methods.json`
are copied into `dist/` so the browser can calculate Buildings Value and
Building Production Efficiency. They remain gitignored and must be
regenerated from a local game install when preparing a release.

### build-production-methods.js

Builds the compact recipe table used by the rural/urban Building Production Efficiency
metrics and mapmodes:

```powershell
node tools/build-production-methods.js
node tools/build-production-methods.js --root="D:\Games\Europa Universalis V"
```

The tool reads goods, production methods, inline unique production methods, building types,
and scripted numeric values from the installed game. It writes only resolved method output
goods/amounts, input goods/amounts, and compact building metadata to
`game_data/production-methods.json`; no Paradox source text is copied. Regenerate it after an
EU5 patch changes production recipes and before a release build. See
[`docs/PRODUCTION_EFFICIENCY_AND_ADDITIONAL_METRICS.md`](../docs/PRODUCTION_EFFICIENCY_AND_ADDITIONAL_METRICS.md)
for the runtime formula and exclusions.
