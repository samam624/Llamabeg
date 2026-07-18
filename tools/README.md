# tools/

One-off/offline data-prep scripts - not part of the runtime app, not run by
end users. Two categories:

- **Map data prep** (`build-location-data.js`, `bake-location-id-map.py`,
  `bake-home-hero.js`) - documented in the root README's "Map setup".
- **Game-install scanners** (`scan-modifier-sources.js`) - read directly from
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

**Not yet built:** resolving *who* grants each indirect bundle (which
event/mission/decision/situation applies it), and cross-referencing the
direct-source list against a loaded save to show which sources a specific
country actually has vs. is missing - see the project's actual
save-parsing code (`js/clausewitz.js`) for what's already extracted
per-country (advances researched, government reforms, laws, estate
privileges) if extending this.

## game_data/ (gitignored)

Both `scan-modifier-sources.js`'s output and any future install-derived
extraction land in `game_data/` at the repo root - never committed, same
treatment as `map_data/`'s raw Paradox files (see that folder's own
README and the root README's "License / data note"). This is Paradox's
own game-design/balance data, not this project's own derived transform of
it, so unlike `map_data/`'s two shipped derived files, nothing here is
intended to ever be committed or deployed.
