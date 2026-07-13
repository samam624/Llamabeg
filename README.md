# EU5 Save Analyzer

A browser-based analyzer for Europa Universalis V save files — players, countries,
and world stats, in the spirit of [pdx.tools](https://pdx.tools) and
[Skanderbeg](https://www.skanderbeg.pm/) (neither of which support EU5 the way this
tool is aimed to).

Replaces an earlier Python/tkinter tool (`~/DiePies-eu5-Save-Analyzer`) that broke
whenever the game's save field names shifted, since it located data by hardcoded
line offsets. This one uses a real (if minimal) parser for the save format instead.

## Status: local MVP

Everything runs client-side, no build step, no server, no upload. Open `index.html`
via a local static server (not `file://` — see below) and drop in **any** `.eu5`
save file — compressed (straight from the game's save folder) or melted (plaintext)
both work.

## How it works

EU5 saves start with a `SAV....` header line, then either:
- plaintext Clausewitz script (`SAV02` + `00` version code), or
- a binary-tokenized format (`SAV02` + `03` version code): a binary metadata block,
  followed by an embedded zip containing two deflate-compressed entries,
  `gamestate` and `string_lookup`.

**Both are parsed entirely in-browser**, with no external token table or server
round-trip required.

### Text parser (`js/clausewitz.js`)

A from-scratch streaming parser for the plaintext format. A full generic parse of an
entire save (500MB+) into JS objects would be too slow and memory-heavy, and 90%+ of
the file (military units, AI memory, character DB, war history, ...) isn't needed
for summary stats. So it walks the file once at the top level and, per top-level
key, either fully parses it (small sections: `metadata`, `played_country`),
parses-and-immediately-discards each entry (`countries.database` — one country
object built and stripped down to the fields we want at a time, so peak memory
stays roughly proportional to one country block, not the whole section), or skips
over it without allocating anything (everything else).

The single generic block parser (`Scanner.parseBlockBody`) handles real-world
quirks found by testing against an actual save: blocks that mix bare array elements
and `key=value` pairs at the same level (`duration={ 1 0=255 }`), and tagged
compound values like `color=rgb { 0 104 166 }`.

### Binary parser (`js/clausewitz-binary.js`)

Initially assumed impossible — EU4's binary ironman format needs a secret,
Paradox-maintained token table that isn't published, and it seemed reasonable EU5
would work the same way. It doesn't: each EU5 save carries its own `string_lookup`
table (a per-save string dictionary), so most field names and content strings are
self-contained. A smaller set of very common structural keys (a few hundred, shared
across Paradox's newer titles) use compact fixed 2-byte IDs instead — see
`js/eu5-fixed-ids.js` for the curated subset this tool actually needs (metadata,
countries, players; not the whole schema).

The format was reverse-engineered by decoding the compressed save's binary
structure and cross-checking it, section by section and field by field, against
the *melted plaintext of that exact same save* (the game/pdx.tools can already melt
saves; we didn't have to guess blind). `test/run-binary.js` codifies that
validation permanently: it parses both the compressed and melted forms of the same
save and diffs every extracted field. Last run: **0 mismatches across 6 saves
spanning game versions 1.1.2, 1.1.10, and 1.3.10** (376,610 total field checks,
12,485 countries, exact metadata and player matches on every save). Beyond those 6
field-level-validated pairs, a corpus sweep of all 59 real saves the user has played
(no melted counterpart, so just checked for internal consistency — no thrown errors,
sane country/player counts) comes back clean on **59 of 59**, spanning versions 1.0.8
through 1.3.10 (the one former holdout is now fixed — see the resolved
`situation_manager`/`0x029c` note below).

Key encoding details worth knowing if this needs revisiting:
- A "key" token can be a fixed 2-byte ID, a `string_lookup` reference (2 bytes +
  1-3 byte index — used for keys too, not just values, e.g. top-level manager names
  like `resolution_manager`), an inline Hollerith string (`0x000f`/`0x0017` — 1.0.x
  saves spell keys like `resolution_manager` out in full instead of using a
  `string_lookup` ref), or an int32-coded token (used for numeric map keys like
  `countries.database`'s country numbers). There are *two* distinct 1-byte-index
  `string_lookup` ref codes, `0x0d40` and `0x0d43` — the second only shows up on
  pre-1.3 saves.
- Fixed-point values (`0x0d48`-`0x0d56`, variable 1-7 byte width) are `raw / 100000`,
  *not* `/10000` as the EU5 wiki's save-game-editing page states for the format in
  general — confirmed by cross-checking decoded currency/score values against melted
  text (they came out exactly 10x too large with `/10000`).
- Dates are hours since year -5000, ignoring leap years:
  `((year + 5000) * 365 + julian_day) * 24 + hour`.
- Telling a map/array **key** apart from a **bare value** requires fully resolving
  the token first, not just peeking 2 bytes ahead for the `=` marker. `resolveToken`
  used to only understand `string_lookup` refs and int32 (leaving anything else as a
  zero-payload placeholder) — fine for genuine unmapped *keys*, but wrong the moment
  a payload-bearing type (fixed-point, bool, string) shows up as a bare array
  element: the peek would land mid-payload, and if those bytes happened to spell
  `0x0001` by coincidence, real data got misread as a fake key and the rest of the
  section desynced. Root-caused twice, from two different games: a market-history
  fixed-point array silently swallowing an entry as a `#hex` key (pre-1.3 save), and
  an inline-Hollerith-string key never being recognized as a key at all (1.0.8 save,
  see above). The general fix: `resolveToken` now delegates its fallback straight to
  `readScalarValue` — the exact function `skipBareValue`/`readBareValue` already use
  for values — so every recognized payload type is *fully* consumed before the
  `=`-peek runs, on both the key path and the value path, from one shared
  implementation. `keyToPropName` guards against a stray bool/color object landing
  in key position instead of crashing on a missing `.fixedNum`.
- A `countries.database` entry isn't always a full country object — some are a bare
  enum value (a tombstone for a merged-away country, e.g. `16779575=<some enum>`).
  Naively accepting "value is a JS object" as "value is a country" let the unresolved
  `{fixedNum}` placeholder for that enum slip through as a phantom empty-tag country;
  fixed by excluding that specific sentinel shape from the guard.

Deflate decompression uses the browser's native `DecompressionStream('deflate-raw')`
(falls back to Node's `zlib` when running under `test/`) — no bundler, no external
zip/inflate library.

**Resolved (was a known limitation): the `situation_manager` desync that cost a
save all its countries/players.** Traced to `0x029c` being an 8-byte integer
code, not 4 bytes like its apparent siblings `0x000c`/`0x0014` — the original
grouping-them-together assumption was wrong specifically for `0x029c`, never
actually exercised at 4 bytes anywhere else in the codebase.
`situation_manager.guelphs_and_ghibellines.variables.data[2]
(gag_total_tax).identity` is a monotonically-growing counter that exceeds
int32 range (observed 23–137 *billion* across real saves); reading its
`0x029c`-coded value as 4 bytes left 4 real payload bytes unconsumed, which
then got misread as a phantom extra token, silently eating the section's real
`CLOSE` and cascading into reading the rest of the file (200MB+) as if still
inside `situation_manager` until it ran off the buffer end — which is also
why it only ever showed up once `includeLocations`/`includeWars` gave the
scan enough surface to reach this section instead of skipping over it
wholesale (both are always on in the real app, so this was a real,
user-visible "0 countries, no error" gap, not just a theoretical one).
Confirmed via exact hex-byte match, not a guess: `53190586800` as 8-byte LE
is `b0 f1 67 62 0c 00 00 00`, exactly the bytes present at that position.
Fixed in `readScalarValue`/`skipScalarValue`/`resolveToken`
(`js/clausewitz-binary.js`) by splitting `0x029c` into its own 8-byte case.
Re-validated: 0 mismatches on all 6 melted-text-paired saves, and (as of
this session) a full 59-save corpus sweep with `includeLocations: true` +
`includeWars: true` (matching the real app exactly) comes back with zero
parse errors and a nonzero country count on every save — the two saves
described above (a 1.1.2 autosave and `autosave_a881d67a-...`, 1.1.10) both
parse cleanly now.

**Caveat:** the fixed-ID table was derived from one save on game version 1.3.10, but
the decoder itself (as of the fixes above) has now been validated against saves from
1.0.8 through 1.3.10 with zero field mismatches on every field-checked pair. Paradox
could still add new fixed IDs in future patches (probably additive, not renumbered,
going by how EU4's equivalent token space has behaved historically, but unverified
for EU5). An unrecognized ID degrades gracefully to a `#hex` placeholder rather than
crashing the parse — worth checking `test/run-binary.js` against a save from a new
patch before trusting results from it. `test/debug-desync*.js` and
`test/debug-anomaly-scan.js` are the tools for tracking down a new mismatch: they
walk the same token stream with instrumentation to pinpoint exactly which
key/position first goes wrong, which is how all of the above were found. For context
on how much more robust this needs to be: even `rakaly/jomini`, the library behind
pdx.tools, explicitly disclaims full cross-patch compatibility and uses the same
reactive "add support as new syntax is encountered" approach — there's no shortcut
around it for a closed-source, undocumented format.

**More fields found the same way (locations + country economy/military):**
`locations.locations` (per-location owner/controller/development/culture/religion/
raw_material/tax — needed for the map) and a large batch of country fields
(`economy` and its sub-fields, `color`, `great_power_rank`, `expected_army_size`,
`expected_navy_size`, `owned_locations`, the `last_months_*_maintenance`/`*_expense`
breakdown, etc.) were added to `js/eu5-fixed-ids.js` by the same position-alignment
method: parse a save both ways, dump one object's keys from each parser side by
side, and read off which `#hex` placeholder lines up with which real field name.
All position-aligned this way, not guessed — a first attempt at guessing the
`economy` sub-object's own field IDs by reusing hex values from an unrelated part of
the country object was wrong and had to be redone properly. Validated with 0
mismatches across all of it (locations: 257,157 field checks over 28,573 locations;
new country fields: 52,584 checks).
- **`0x0d47` is a dedicated "value is exactly 0" code**, not an unmapped fixed ID.
  Found because `expected_army_size`/`expected_navy_size` came out as `{fixedNum:
  3399}` (3399 = `0x0d47`) instead of `0`, exactly on the countries where melted
  text had `0` — every sampled occurrence is immediately followed by a valid next
  token (a `CLOSE`, a fresh key) with zero gap, consistent with a genuine
  zero-payload sentinel rather than a value type we're missing bytes for. This is
  also almost certainly why `situation_manager` (the still-unexplained known
  limitation above) was so anomaly-heavy in earlier debugging — 0 is an extremely
  common value — though that section wasn't re-investigated after this fix since it
  doesn't affect anything the app currently reads.

**`war_manager` and its `database` entries (for the Llama score feature below):**
`war_manager` itself resolves to an unmapped fixed ID with no matching key anywhere
in a naive top-level walk — turned out to be because the walk desyncs on an unrelated
value type before ever reaching it (same generic-decode fragility as everything else
in this section), not because the ID was missing. Found instead by **position
alignment at the top level**: both formats have exactly the same number of top-level
keys in the same order for a given save (116, in the validation save used), so
`war_manager`'s index (51) could be read straight off the melted text's top-level key
list and matched to the *same-index* unresolved `#hex` key in a full top-level binary
walk — confirmed further by the text/binary byte-size ratio (≈2.9x) falling in the
same 1.7–2.9x range as every other already-confirmed key at that scale
(`diplomacy_manager`, `countries`, `estate_manager`). Inside `war_manager.database`,
the 20 new field IDs (`all`, `history`, `request`, `reason`, `join_type`, `side`,
`revolter`, `called_ally`, `joined`, `left`, `original_attacker`,
`original_attacker_target`, `original_defenders`, `revolt`, `previous`, `start_date`,
`end_date`, `war_goal_held`, `attacker_score`, `defender_score`, plus `names`) were
derived by decoding one **exact, known war entry** (matched across formats by its war
number, which is cross-format-stable) generically and reading off its key order
against the already-fully-understood melted-text dump of that same war — done against
three separate real wars (a short 2-participant concluded war with no battles, an
active multi-party revolt war with a called-in ally, and a war with only
`defender_score` set) to cover the optional-field variations. `country`/`date`/
`score`/`status`/`locations` inside a war entry reuse fixed IDs already in the table
for other sections — confirmed, not coincidence (values line up exactly). Validated
0 mismatches across 520-1197 field checks per save on 5 of the 6 validation saves (the
6th hits the pre-existing `a881d67a` crash above, unrelated to this section).
Pre-1.3 saves omit `war_manager`'s `names` sub-block entirely (goes straight to
`database`) — the same kind of version-dependent shape difference as the
`countries`/`played_country` nesting quirk described above, handled the same way
(accept either shape rather than assuming one).

Also caught here: `revolter=Yes` (capital Y) is a *different* token from the `yes`
boolean literal `coerceScalar()` lowercases in the text parser — it comes through as
the literal string `"Yes"`, not `true`. `extractWarFields` (`js/clausewitz.js`) checks
both spellings; binary dates inside a war entry (`start_date`/`end_date`/per-
participant `joined.date`/`left.date`) arrive as raw hour counts needing the same
`dateFromHours()` conversion `extractBlackDeathBinary` already does for
`situation_manager.black_death` — missing that conversion was the first version's
actual bug (0 mismatches only after adding it), not a fixed-ID error.

### Map (`js/map.js`, `map_data/`, `tools/`)

Renders a pdx.tools-style province map with toggleable mapmodes (political,
players, development, population, trade goods, religion, culture), mouse-wheel
zoom, drag-to-pan, and hover tooltips, using the game's own map bitmap plus
per-location data pulled from the save.

- **Sea vs. land.** `default.map`'s `sea_zones`/`lakes` lists (location *names*,
  cross-referenced the same way as the color table) mark each location as
  water or land; water always renders as blue regardless of mapmode, and a
  coastline is drawn wherever a water/land boundary crosses a pixel, so
  unowned/unclaimed land (much of Africa in an early-game save) still reads as
  a continent instead of disconnected color specks floating in a void.
- **Player nations get a thick outline**, drawn on top of *any* mapmode (not
  just the dedicated "Players" mode) so they stay easy to spot while browsing
  others. Each side of the line is colored with a dark shade of *that side's
  own* political color (via `shadeColor`, not a neighbor's, not uniform
  white) — so where two player nations actually border each other, the seam
  is visibly two-toned instead of one indistinguishable line, and the
  outline still reads as "this is player-owned" no matter which mapmode is
  active, matching the old white outline's "always visible" intent.
- **"Shade vassals by overlord"** toggle: when on, a subject's location colors
  as a lightened/darkened shade of its overlord's color instead of its own,
  using the same subject/overlord data as the "X (Y subject)" political
  tooltip (see `dependency` records below). Multiple vassals of the same
  overlord get different deterministic shade offsets so they're still
  distinguishable from each other, not just from the overlord.
- **Trade goods** mapmode colors by each location's `raw_material` string
  (hashed to a color, since goods aren't numeric IDs) — inherently a "busier"
  mapmode than the others since raw materials vary location-by-location, not
  regionally; that's expected, not a bug.

The tricky part wasn't parsing — it was figuring out how a pixel *color* on the
game's `locations.png` maps to a specific location, since (unlike EU4's
`definition.csv`) EU5 ships no color→ID table. The answer, pieced together from
three separate files:
- **Location numbering** (matching the same IDs the save format itself uses) is
  the 1-based order locations appear when flattening `definitions.txt`'s nested
  continent/region/area/province tree — confirmed against real save data, not
  assumed: location #1 in that ordering is `stockholm`, and Sweden's `capital`
  field in a real save is `1`.
- **Name → color** comes from `named_locations/00_default.txt` (found via the
  [EU5 modding wiki](https://eu5.paradoxwikis.com/Map_modding) — not documented
  anywhere in the shipped file structure itself), after fixing two parsing bugs
  (trailing `#comment` text after both a bare `#` comment line and after a real
  `name = color` line, which a naive regex anchored on end-of-line rejected).
- End-to-end validation: all 28,573 locations resolve to a color, every color is
  unique, and the count matches `locations.png`'s actual unique-color count
  (28,573) exactly. Geographic sanity-checked too — `stockholm`'s pixel blob sits
  directly adjacent to `norrtalje`'s, matching real-world geography.

`tools/build-location-data.js` and `tools/bake-location-id-map.py` turn that into
what the app actually loads: `map_data/locations.json` (id → name) and
`map_data/location_ids.png`, a *derived* 16384×8192 image where pixel R+G channels
directly encode the location ID — a data-only transform of the game's map, not a
copy of Paradox's artwork. The raw `locations.png`/`definitions.txt` are Paradox's
copyrighted files and are never committed or served; see `map_data/README.md` for
the (one-time, local) setup a checkout needs before the map will load.

`colorFor()` does a couple of `Map` lookups, too slow to call per-pixel over 134M
pixels (16384×8192); instead it runs once per *unique* location id (≤28,573) to
fill a flat `Uint8ClampedArray` lookup table (`buildLUTs()`), and the actual
per-pixel work is just an array index into that LUT.

**Rendering is viewport-based, not full-world.** The old approach rendered
all 134M source pixels into one giant canvas on every mapmode/vassal-toggle
change, then panned/zoomed it purely via a CSS `transform: scale()/translate()`
— cheap to pan (GPU-composited), but it meant the *border* was dilated by a
fixed pixel radius in *source* space, and a thin source-space line aliases
away unpredictably once the browser's own downsampling (or, before
`image-rendering: pixelated`, its bilinear smoothing) shrinks it for a
zoomed-out view — that's what made the border look "patchy" even after
switching to a proper 2-pass box dilation (horizontal sliding-window pass,
then vertical; an earlier version that sampled only 4 fixed-offset points
left gaps on non-axis-aligned boundaries, which was a separate, also-fixed
bug). `renderViewport()` (`js/map.js`) replaces all of this: on every
pan/zoom/mode change it computes which source rectangle is currently visible
and renders *only* that, into a canvas sized to the viewport's own CSS box
(× `devicePixelRatio`, capped at 2) — typically a few million pixels, not
134M. Border/coastline detection happens by comparing already-downsampled
*destination* pixels instead of dilating a source-space mask, so the line is
a consistent ~2–3 *screen* px wide at any zoom level (never thinner than one
destination pixel, so it can't alias away). `playerOwnedLUT` still walks the
`dependency` overlord chain (capped at 8 hops), so a player's vassals are
inside their border too, not just their core provinces.

Coordinate mapping: `view = { scale, offX, offY }` is a source→screen affine
(`screenX = srcX*scale + offX`), initialized to a "contain" fit (whole map
visible, centered, letterboxed on whichever axis doesn't exactly fill —
`computeFit()`) and updated directly by wheel-zoom/drag-pan instead of being
translated into a CSS transform. `clampAxis()` keeps panning from dragging
the map fully out of view. Pan/zoom re-renders are throttled through
`requestAnimationFrame` (`scheduleRender()`) so rapid wheel/mousemove events
coalesce to one render per frame; explicit actions (mode switch, vassal
toggle, reset zoom) render immediately. A `ResizeObserver` on the wrap
re-clamps and re-renders on container resize, since the canvas backing store
now matches the wrap's own box instead of a fixed 16384×8192 (`image-rendering:
pixelated` is still set as a rounding-error safety net, but is no longer
load-bearing the way it was under the old CSS-transform approach).

**Fixed: per-load listener/observer leak.** `createMapView()` tears down and
rebuilds its whole DOM subtree on every call (a new save loaded, or switching
back to the Map tab), but the drag-to-pan handlers in `setupPanZoom()` are
registered on `window` (needed so a drag in progress keeps tracking the mouse
even after it leaves the canvas) rather than on the canvas/wrap elements that
get discarded — those aren't cleaned up automatically the way node-scoped
listeners are when their element goes away. Confirmed by instrumentation
(Chrome DevTools Protocol `DOMDebugger.getEventListeners` on `window`): before
the fix, loading 4 saves in a row left 5 stacked `mousemove`/`mouseup`
listeners (each holding the previous session's now-detached canvas alive);
after, the count stays flat at 1 regardless of how many saves are loaded.
`createMapView()` now scopes each session's window listeners to an
`AbortController` and disconnects the previous session's `ResizeObserver`
before building the next one.

**Fixed: player-realm border silently missing along most player/AI
frontiers.** The border-detection pass suppresses drawing a boundary line
around a small unclaimed pocket fully enclosed by one realm (so a single
unowned tile inside your territory doesn't get a distracting ring around
it) by comparing a per-location "which realm encloses this neutral pocket"
lookup table against each side's owning realm. That lookup table defaults
to `0` for *every* location that isn't an actually-enclosed pocket —
including all ordinary AI-owned land — and the comparison never checked
that the looked-up value was non-zero before trusting it, so it collapsed
into `0 === 0` and fired at *any* plain player/AI edge, not just genuine
enclosed pockets. In practice this suppressed the border almost everywhere
a player's territory touched AI territory (only player-vs-player borders,
where both sides are non-zero, survived) — confirmed with a real
before/after screenshot pair on a real save: entire frontier stretches (a
peninsula, a wide inland extension) had no border line at all before the
fix. One-line fix: require the enclosed-realm lookup to be non-zero before
trusting the equality check.

**Player-nation labels: pinned to the capital, not a computed centroid.**
An earlier centroid-based approach (average of every owned pixel, snapped
to the nearest actually-owned point) still broke for an empire with a
compact overseas holding some distance from its main territory — the
centroid gets pulled toward wherever the point cloud averages out, not
reliably toward the capital. `computePlayerLabels()` (`js/map.js`) now
just scans the map once for each player country's `capital` location id
and puts the label directly there — no averaging, no snapping, no
special-casing. Verified on a real save where the old approach put
Portugal's and Aragon's labels isolated over the Sahara instead of Iberia;
after the fix they sit correctly with the rest of their region's labels.

**Fixed: a location can show unowned on the map even when it's genuinely
controlled — a real, previously-unknown gap, not a minor edge case.** EU5
tracks ownership at *two* levels: `locations.locations.<id>.owner`
(per-location, all this app read before) and `provinces.database.<n>.owner`
(a coarser grouping — several locations per province, matching
`definitions.txt`'s `..._province` level). **A location's own owner field
can be completely blank while its containing province has a real owner**
— confirmed directly against raw save text: a real, populated city had
*only* market-graph fields (`market`, `market_access`, `value_flow`, …) and
no `owner=` at all, while its province (and two neighboring ones — 12
locations total in that one small cluster) had a real owner set correctly.
The in-game client and third-party tools read ownership at the province
level; this app only ever read the location level, so those locations
rendered as unowned "holes" inside an otherwise normally-colored empire —
found because a user cross-checked the same save in the actual game client
and in a third-party tool, both showing correct data, which was the right
call to keep digging rather than trust "I already verified the field I'm
reading is correct" (see the fix write-up below for how deep that initial,
wrong-conclusion verification went before the real second data source was
found). **Scale, measured on one real save: 2,389 of 28,573 locations
(~10%) were affected** — one player's true location count was 372, not the
300 the app showed before the fix.

Fix, across the whole pipeline:
- `tools/build-location-data.js`: the location-id derivation now also
  records each location's enclosing `..._province` name (its immediate
  parent in the `definitions.txt` tree — correct by construction, including
  through a real oddity in the source file where `limousin_province` is
  used as both an area name and, one level inside that, a real province
  name — parent-key tracking naturally resolves to the correct/innermost
  one regardless). `map_data/locations.json` regenerated with the new
  `province` field on every entry.
- Both parsers gained `provinces.database` extraction
  (`parseProvincesSection`/`extractProvinceOwner` in `js/clausewitz.js`,
  mirrored in `js/clausewitz-binary.js`) — each entry fully parsed then
  reduced to `{definition, owner}` and discarded, same treatment as
  `war_manager.database` (not huge — ~4,000 modest entries, not a per-
  location resistance blob). Produces `result.provinceOwnerByDefinition`.
  Two new binary fixed IDs: `provinces` (`0x6b7`), `province_definition`
  (`0x2dc2`).
- `js/map.js`'s new `applyProvinceOwnerFallback()`, run once right after
  `map_data/locations.json` loads, fills in a location's `owner`/
  `controller` from its province's owner whenever the location's own field
  is blank — mutates `result.locations` in place so every consumer (map
  fill/borders, the location/country detail panels, tooltips, the country
  table's location counts) sees the corrected value uniformly, not just
  whichever one happens to check first.
- `js/parse-worker.js` needed its result-field whitelist extended too —
  worth double-checking whenever a parser change adds a new top-level
  result field, since the worker (the default parse path in the real
  browser flow) silently drops anything not explicitly listed there.

A general binary-decoder gap was found and fixed along the way: a fixed-ID
token appearing in *value* position (not just key position — e.g.
`situation_manager`'s `{type=disease_outbreak, identity=N}` enum-tag
reference, needed for the Black Death fix below) only ever decoded to an
opaque placeholder object, because `readScalarValue()`'s fallback for an
unmapped code never consulted the fixed-ID table the way `keyToPropName()`
already does for keys. Fixed by having that fallback check the table too —
low-risk (only changes behavior for codes now explicitly listed, and the
`!("fixedNum" in obj)` tombstone-detection checks used elsewhere only ever
apply to a whole database entry's outer decoded value, never a nested
field, so they're unaffected).

Re-validated after all of the above: all 6 melted/binary pairs still 0
field mismatches, and a fresh 59-save corpus sweep (parsed with the same
`includeLocations`/`includeWars` settings the real app uses) came back with
zero parse errors and non-empty province data on every save.

### Subject/overlord relationships (`dependency` records)

Vassals, tributaries, dominions, etc. aren't a field on the country object —
they live in `diplomacy_manager`, mixed in among a much larger per-country-pair
trust/rivalry section (skipped, not needed) as repeated `dependency` entries:
`{ first=<overlord number> second=<subject number> named_targets={{ flag=
subject_type target={ object=vassal|tributary|dominion|... } }} }`. Both
parsers walk `diplomacy_manager` selectively (like `locations.locations`) and
extract just these into `result.dependencies`. Validated: 431/431 dependencies
match exactly between the binary and text parse of the same save, covering 10
distinct subject types observed in one save (vassal, dominion, tributary,
fiefdom, hanseatic_member, tusi, appanage, secessionists, maha_samanta,
state_bank).

### Player-session history

`played_country` entries accumulate one per session — reconnects, and (in a
long-running multiplayer campaign) a different human taking over an existing
seat entirely. There's no timestamp on these, but they're written in a stable
order that does reflect recency (confirmed: a country with two different named
players had the later name's sessions consistently interleaved after the
earlier one's) — so only the *last* entry per country is kept as that
country's current controller. A player who's stopped showing up for good but
hasn't been replaced by anyone else has no distinguishing signal in the save
at all (it's a snapshot of game state, not a connection log), so that case is
a manual "Hide" button per player row (`js/app.js`), persisted in
`localStorage` — an honest limitation rather than a guessed heuristic.

Both parsers also now keep the *uncollapsed* history as `result.playerSessions`
(every `played_country` entry, not just the last per country) for the Llama
score feature below, which needs to know every human who's ever controlled a
country to offer as a manual reassignment option. This does **not** solve
war-to-player attribution by date, though — there's still no timestamp on a
session, only file-order recency, which doesn't line up with a specific war's
known start/end dates. So a country with more than one historical player is
just flagged "ambiguous" and defaults to its current controller; the actual
call is left to the review table.

**Fixed: a player could show as the current controller of two different
countries at once.** The per-country "last entry wins" collapse above only
dedupes *within* one country's own history — it doesn't catch a player who
abandoned an earlier country for a new one, with nobody ever taking over the
old one since. Both countries' histories independently look like a valid
single-controller record in isolation, so both survived the collapse.
Confirmed on a real save: a player's last session on one country and later
session on a different one both survived, so the map labeled them over both
countries' capitals and the Black Death/Players tables listed them twice.
Fixed with a second pass (`collapsePlayerSessions()`, factored out of
`js/clausewitz.js` and shared by `js/clausewitz-binary.js` rather than
duplicated): group the per-country-collapsed list by player name, and for
any name still controlling more than one country, keep only the one whose
session is most recent in `playerSessions`' file order and drop the player
from the older country entirely (left with no current player, since there's
no reliable "who controls it now instead" signal — not a stale/duplicate
one). Fixes the map label, Black Death table, and Players table at once,
since all three read the same `country.players`/`result.players`.

### Economy/military fields and trend charts

`color`, `economy` (and its `income`/`expense`/`creditworthiness`/
`monthly_gold` sub-fields), `great_power_rank`, `expected_army_size`/
`expected_navy_size`, `last_months_population`, `historical_population`,
`historical_tax_base`, and the `last_months_*_maintenance`/`*_expense`
breakdown were all added to `extractCountryFields` and derived/validated by
the same position-alignment method as the `locations` fields (see the
binary-parser section above) — including one wrong guess along the way
(reusing hex values from an unrelated part of the country object for
`economy`'s own sub-fields) that had to be redone properly. `js/app.js`
derives a few more metrics client-side rather than storing them: profit
(income − expense), "efficiency" (profit ÷ income, i.e. share of gross income
kept rather than spent), and income/tax-base per population.

`js/charts.js` renders the two "Trends" line charts (population, tax base,
both over time using `historical_population`/`historical_tax_base`) — one line
per current player, using the last historical entry's exact match to the
country's current `last_months_population` to confirm each array entry is one
calendar year, letting the x-axis be derived (`currentYear - (length-1-i)`)
without needing a separate start-date field.

**Fixed: shorter-history countries were plotted against the wrong years.**
`historical_population`/`historical_tax_base` aren't the same length for
every country — a nation formed or released partway through the campaign
(a revolution, a colonial release, ...) has fewer yearly entries than one
that's existed since game start. `renderTrends()` (`js/app.js`) used to
derive the shared year axis from *the first player's* history length only
and plot every series by raw array index; a shorter series then landed at
indices `0..N-1`, which `charts.js` maps to the *oldest* N years on that
axis — silently mislabeling a young country's actual recent history as
ancient. Since every array's *last* entry is always "now" regardless of
length, the axis is now sized to the *longest* history among the current
players and every series is right-aligned to it (padded with `undefined`
at the front, which `charts.js` already renders as a gap), so a country's
last data point always lines up with the correct current year no matter
how much history it has.

### Black Death analyzer

Ranks countries by population lost to the Black Death. The event's window is
directly available rather than needing to be inferred from a population dip:
`situation_manager.<name>` tracks ~20 scripted historical events by name
(`black_death`, `hundred_years_war`, `sengoku`, ...), and
`black_death.status`/`.start`/`.end` give the exact date range once it's
fired (`{ }` beforehand). Added to both parsers as `result.blackDeath` — the
text side (`js/clausewitz.js`) fully parses the small (~3KB even in a large
save) `situation_manager` block and reads off `black_death` directly; the
binary side (`js/clausewitz-binary.js`) needed three new fixed IDs
(`situation_manager`, `status`, `start`/`end` — the situation *names* like
`black_death` are `string_lookup` refs already, not fixed IDs, so only the
manager and its two/three child keys needed deriving). `start`/`end` decode
through the same `dateFromHours()` used for `metadata.date`.

**Per-country death counts, not a population-before/after diff.** The
original approach read each country's population at the event's start year
and end year (via `historical_population`) and computed the difference —
simple, but wrong: any land a country gained or lost during the outbreak
window (conquest, colonization, a war loss) shows up in that diff too, with
nothing to do with actual plague deaths, and can even make the number go
*negative* for a country that expanded faster than it lost people. EU5 tracks
the real number directly: `disease_outbreak_manager.data[]` (one entry per
disease *type* ever seen — bubonic plague, malaria, typhus, ...) carries a
`countries` sub-list of `{county: <country>, deaths: [{disease_outbreak:
<outbreak id>, deaths: <float>}]}` — a running per-country death tally,
attributed to whichever country owned a location at the *moment* of each
death, split out per distinct outbreak instance (a country can suffer more
than one separate bubonic-plague wave across a long campaign — only the
`disease_outbreak` id matching `situation_manager.black_death`'s own
`{type=disease_outbreak, identity=N}` pointer counts as "the" Black Death,
not every wave). This is the same number the in-game "disease breakdown" UI
reads.

`disease_outbreak_manager` can be 400K+ lines melted in a large save — almost
entirely a per-location resistance/immunity simulation blob (`locations=`)
that has nothing to do with death counts — so both parsers implement this as
a selective walk (`parseDiseaseOutbreakManagerSection` in each), skipping
that sub-object entirely and only materializing the much smaller `countries`
breakdown (~1,200–1,900 rows in the corpus, not hundreds of thousands), same
discard-after-extract treatment as `war_manager.database`. Only runs at all
once `situation_manager.black_death`'s identity is known (i.e. the event has
actually started this campaign) — otherwise skipped wholesale at the same
cost as any other unhandled top-level key. New binary fixed IDs:
`disease_outbreak_manager` needed none (resolves via `string_lookup`
already), but its contents needed six: `variables`, `data`, `identity`,
`disease_outbreak`, `county`, `deaths`.

`result.blackDeath` gained `identity` (the target outbreak id) and
`deathsByCountry` (`{countryNumber: totalDeaths}`, same raw units as
`historical_population` — feed it through the same `fmtPopulation()` ×1000
helper, don't double-scale). `renderBlackDeath()` (`js/app.js`) now shows
Tag / Player(s) / Population (start) / Black Death Deaths / Lost % — Lost %
= deaths ÷ population-at-start. The old "Population (end)"/raw "Lost" columns
are gone entirely, not kept as a fallback. Cross-validated binary vs. text to
5 decimal places on the same save, 0 regressions on the existing 6-pair
field-diff suite, and a 59-save corpus sweep (parsed the same way the real
app does) came back with zero parse errors — 51 of 59 saves had disease data
by their save date, the other 8 are early enough the Black Death hasn't
struck yet.

### Llama score (war scoring)

Port of the user's EU4 multiplayer scoring spreadsheet (`Llama Points *.pdf`/`.xlsx`
at the repo root — the real formula is from the `.xlsx`; the PDF describes an earlier
design that was never what the spreadsheet actually computed): for each player,
`LlamaPoints = GP_Score/100 + Σ(war scores)`, where each war contributes
`10·E·W/(A+1) + 10·(W−1)·(A+1)/(2·E)` (or `2·C·(2W−1)` when `E=0`, a condottieri
contract with no direct enemy) from that player's count of distinct enemy countries
(E), distinct allied countries excluding self (A), win flag (W), and condottieri flag
(C) in that war. `js/llama-score.js` implements this as a pure function
(`computeLlamaScores(result, overrides)`) over the new `war_manager` extraction (see
the binary-parser section above) — no DOM/localStorage access, so it runs the same in
Node or the browser.

E and A are fully mechanical (count distinct countries by side in the war's
participant list, from `js/clausewitz.js`'s `extractWarFields`). **W is not**: EU5
clears `attacker_score`/`defender_score`/`war_goal_held` once a war concludes, and
participant `status`/`left.reason` (`"Left"`/`"WarEnded"`) is identical for winners
and losers alike — confirmed by direct inspection, no clean win/loss field survives.
What *does* survive is the `locations` occupation snapshot, so `extractWarFields`
summarizes it into attacker/defender location counts, and the score engine's
heuristic guesses the winner as whichever side ended up holding more of them — flagged
`uncertain` on a tie or when nothing changed hands at all. GP_Score is the sum of
`score.score_rank.{ADM,DIP,MIL}` (a fixed ID already in the table, just not
previously wired into `extractCountryFields`) — the closest field to the
spreadsheet's "GP Score" column by order of magnitude, but this is a different game
from the original EU4 spreadsheet, so it's a sanity-checked estimate, not an exact
validated match; the UI says so.

Given both of those are best-effort, `js/app.js`'s "Wars (review & correct)" table
(reusing `renderSortableTable`) shows every player-controlled war participant with
its computed E/A/win-guess/score, and lets a user override win/loss, mark a war as a
condottieri contract, exclude a war entirely, or reassign it to a different historical
player (populated from `result.playerSessions` when a country changed hands - see
"Player-session history" above). Corrections persist to `localStorage` keyed by save
id + war id + country (`eu5-analyzer-llama-overrides:<saveId>`), mirroring the
excluded-players pattern, so they survive reloads of the same save without affecting
any other save. Active wars are always excluded from scoring (no win/loss to guess
yet), shown as "in progress" rather than silently scored as a loss. The leaderboard
(`Charts.renderBarChart`, a small horizontal-bar addition to `js/charts.js`) always
lists every current player, even ones with zero wars (GP_Score alone still counts).

**Campaign-ledger mode: scoring wars a single save can never see.** A save-by-save
view has a structural blind spot: EU5 purges a concluded war from `war_manager` once
it's over, sometimes faster than the autosave interval, so a war can go straight from
`active` to *gone* with no snapshot ever showing it as concluded (see the binary-parser
section's `war_manager` writeup). `llama-score-automatic-logging-machine/` is a small
standalone Node recorder (not part of the browser app) that watches the save folder in
real time, parses each new autosave with the same `js/clausewitz.js`/
`js/clausewitz-binary.js` parsers, and appends a compact per-campaign ledger
(`data/campaigns/<uuid>/{snapshots,war-events}.jsonl`) — so a war that gets purged
before the next autosave is still caught, because the recorder saw it *while it was
still active* rather than only checking after the fact. `js/llama-score.js`'s
`computeFromLedger(snapshots, events, overrides)` scores from this ledger instead of a
single save's `result.wars`; `js/app.js`'s "Llama Score" panel prefers this mode
whenever a ledger is loaded (via the manual `.jsonl` file pickers, or `js/ledger-
connect.js`'s File System Access API folder connection, Chromium-only) and falls back
to the single-save view otherwise.

**Automatic "player left the campaign" detection**, so an abandoned country's later
wars don't score for *or* against anyone. The concern this closes off: once a player
stops playing, their country reverts to AI control, and another player could otherwise
farm free "wins" off that now-defenseless shell — inflating their score off a fight
that isn't really PvP anymore. `buildDepartureDates()` (`js/llama-score.js`) scans
every recorded ledger snapshot in order and flags a country as departed at the first
later snapshot where it's recorded with zero players, after having genuinely had one.
**In practice this almost never fires**: a save has no "still connected" flag at
all — a country's player list is just its last `played_country` entry (see
"Player-session history" above), which never clears on its own once someone's played
it, reconnect or not. So a player who simply stops showing up for good (confirmed on a
real campaign: a player farmed for score across two sessions after departing, with the
opponent they kept "beating" also still being penalized) is invisible to every
save/snapshot the recorder ever captures — there's no live-connection signal anywhere
in the data, recorder running or not.

The actual fix is the existing manual "Hide" button on the Players table
(`eu5-analyzer-excluded-players` in `localStorage`, `js/app.js`) — now wired into
`computeLlamaScores`/`computeFromLedger` as an `excludedPlayers` argument. Hiding a
player: (1) drops their own leaderboard entry entirely, (2) auto-excludes their own war
rows (`"player-hidden"` reason), and (3) — the part that used to be missed — also
auto-excludes *their opponents'* rows against them (`"opponent-departed"`, same reason
string `buildDepartureDates()` uses, now reachable through this path too), via an
`attributedPlayerFor(country)` lookup on the enemy side of each war. Without step 3, a
still-active player who'd fought the departed one kept their win/loss score frozen in
from that fight forever, even after the "phantom" was hidden - hiding the wrong side of
the matchup didn't undo the damage to the right side. `E`/`A` (enemy/ally counts) and
`isPvP` themselves are deliberately left alone by this - they reflect who was actually
fighting at the time, so hiding someone later doesn't retroactively rewrite the war
score of fights that were legitimate when they happened, only the *newly-phantom*
ones. Surfaced in the "Exclude" column as a dismissable `auto` badge with the reason in
its tooltip; a manual per-war override still wins if the automatic read is wrong.

### Ocean/lake caveat

Sea/lake classification is per-*location*, not aggregated into named bodies of
water (the Baltic Sea's dozen-plus constituent zones each render as separate
same-colored patches, not one labeled region) — good enough for the coastline
outline and blue fill, not for a "hover the Mediterranean, see its name"
feature.

### UI

`js/parse-worker.js` runs the parse in a Web Worker so the page doesn't freeze on
large files; `js/app.js` falls back to parsing on the main thread if Workers aren't
available (e.g. some `file://` contexts).

**Tab layout: Load Save / Metrics / Graphs / Llama Score / Map.** Used to be a single
"Statistics" tab holding the overview stats, both trend charts, the Players/Countries
tables, Black Death, *and* the Llama Score panel all at once, laid out in a 2-column
CSS grid only two of those sections were actually coded to span — the rest landed in
mismatched half-width columns. Split into five tabs (`index.html`'s `#results` nav,
`js/app.js`'s `tabPanels`/`activateTab`), each a plain single-column flex stack now:
- **Load Save** — the uploader + "Recent saves" panel, which used to sit permanently
  above the tabs even after a save was loaded. Now it's its own tab — the *only* one
  shown pre-load (`setResultTabsAvailable()` keeps Metrics/Graphs/Map hidden until a
  save actually parses), and once a save loads, the view auto-jumps to Metrics and
  Load Save just waits in the nav for
  next time (`onParsed`'s `wasOnLoadTab` check — only auto-navigates away if you were
  actually on it, so reloading a different save while on e.g. Map doesn't yank you
  away from what you were looking at).
- **Metrics** — Overview, Players, Black Death, Countries.
- **Graphs** — the population/tax-base trend charts.
- **Llama Score** — unchanged content, just its own tab now instead of a
  toggle-revealed panel wedged into Statistics. Visibility rule is unchanged (hidden
  until auto-linked or the "Show Llama Score" checkbox is on, `updateLlamaPanelVisibility`)
  but now targets the tab *button*'s `hidden` instead of the panel's, and redirects away
  from itself if it stops being available while active.
- **Map** — unchanged.

Small icon sprites (`Special:Redirect/file/<Name>.png` from the EU5 wiki, same pattern
`MAP_MODE_ICONS` in `js/map.js` already used for map-mode buttons) were added to each
tab button and to the Key/Economy/Military/Demographic metric-tab buttons — each
filename was checked with a `curl` HEAD request for a real `image/png` response before
use, since a few obvious guesses (`Black Death.png`, `Statistics.png`, `Chart.png`)
404. Llama Score uses a 🦙 emoji instead — no EU5 wiki asset fits, and an emoji has no
broken-link risk.

**Map aspect ratio.** `.map-canvas-wrap` used to be `height: min(76vh, 760px)` at
whatever width its (now full-width, single-column) container gave it — on a wide
monitor that's a very short, very wide banner. Now `aspect-ratio: 16/10` with a
`max-width: 1500px` cap on `.map-body`, closer to an actual monitor's shape.

**Black Death "Lost %" color gradient**, green (least population lost) to red (most),
scaled to the *loaded save's own* min/max rather than a fixed 0–100% axis — real
per-country tallies cluster in a fairly narrow band (e.g. 20–40% in one test campaign),
which would all read as a near-identical color against the full range. Originally its
own bespoke text-color gradient (`lossPctColor()`); now goes through the same
`metric-heat` background-fill mechanism every other heat column uses instead (see the
Campaign Ledger section below for why and how) — no bespoke color code left for this
column at all.

**Fixed: unescaped error text passed to `innerHTML`.** `showError()`
(`js/app.js`) writes its argument straight into `errorBox.innerHTML`, which
is intentional for the two call sites that embed literal `<code>` tags
around an already-`escapeHtml()`-ed value — but three other call sites were
concatenating a raw `Error.message` (from a failed file read, or from the
parse worker/main-thread parse's catch block) into that same string
un-escaped. Not currently reachable with attacker-controlled HTML (the
parser's own thrown messages are either static or built from fixed literals,
never raw file content), but it's the kind of latent injection point that
stops being safe the moment a future error message includes more context
(a tag, a file name) without someone re-deriving that history first. All
three now wrap the dynamic `.message` in `escapeHtml()`, consistent with how
the format-code and map-loading error paths already did it.

### Visual design — the "Campaign Ledger" reskin

The app's original look was a fairly generic dark-mode-SaaS palette (`#14181f`
background, `#5b9dd9` accent blue, system-font stack) — asked to be redesigned
into something less "default AI-generated." Three concrete directions were
mocked up as a Claude.ai artifact (a parchment/wax-seal "Campaign Ledger," a
navy/brass instrument-panel "Chart Room," and a warm-stone editorial "Field
Report") using the app's own real components (header, tab nav, a country
table, the Llama Score leaderboard) rather than abstract swatches, so the
choice was made against how it'd actually look, not a mood board. **Campaign
Ledger** — parchment, wax-seal red, gold-tan hairlines, italic serif
headers, monospace numeric columns — was picked as the closest fit for a
Paradox/EU5 tool.

**Token architecture.** Everything routes through the same `:root` CSS
custom-property set already in place before the reskin (`--bg`, `--panel-bg`,
`--panel-border`, `--text`, `--text-dim`, `--accent`, `--good`, `--bad`, plus
new `--gold`, `--rule-strong`, `--row-hover`, `--font-mono`) — no build step,
no CSS framework, just new values. Border-radius flattened to 2–3px
everywhere (was 4–10px) to read as ledger-page corners rather than the
rounded-card look most default UI kits share.

**Dark mode is the actual default**, not merely an OS-preference fallback —
`:root` itself holds the dark "leather-bound ledger at night" palette
(`--bg #1c150e`, `--panel-bg #2b2015`, `--text #f1e6c8`, `--accent #c25b4f`,
etc.), and `:root[data-theme="light"]` is the opt-in override for the
parchment-by-day palette (`--bg #e7dcc0`, `--accent #7a2e2e`, …) — the
reverse of how the first pass shipped it, swapped after the user asked for
dark specifically rather than as an OS-preference-driven default. A
`#themeToggleBtn` in the header (☾/☀, flips direction with the theme) stamps
`document.documentElement.dataset.theme` and persists it to
`localStorage["eu5-analyzer-theme"]`; a small inline `<script>` in
`index.html`'s `<head>` (before the stylesheet) applies any saved choice
synchronously so a returning visitor never flashes the other theme first.
Gold-tan hairlines (`--panel-border`, `--rule-strong`) are the same value in
both themes — proven to read fine on dark already, since the map's floating
HUD chrome (below) already used this exact gold on a dark background before
dark mode existed as an option.

**The map's floating panels stay dark regardless of page theme** —
`.map-toolbar`, `.map-legend`, `.map-tooltip`, `.location-details`/
`.country-details` float over the game map canvas itself, so they're a fixed
warm-brown-black HUD (not tied to `--bg`) either way. Done by **scoping
`--text`/`--text-dim`/`--accent` overrides directly on those container
selectors** rather than writing per-rule dark/light variants — every
descendant already referencing `var(--text)` etc. picks up the HUD-local
values automatically through normal CSS inheritance.

**`js/charts.js` reads its palette from CSS custom properties at render
time** (`chartTokens()` calls `getComputedStyle(document.documentElement)`
for `--chart-surface`/`--chart-gridline`/`--chart-axis-text`/
`--chart-label-text`/`--chart-total-bar`/`--chart-series-1..8`) instead of
hardcoding two parallel JS palettes that could drift out of sync with the
CSS ones. Toggling the theme just means re-running whichever render function
last drew a chart (`renderTrends()`/the Llama Score leaderboard's
`currentLlamaDraw()`, both called from the toggle's click handler) — no
separate "repaint" API needed. The categorical series palette (used for the
Graphs-tab trend lines) is the exact 8-color set the app used before this
reskin for its one and only theme; both the light and dark versions were
validated with the `dataviz` skill's `scripts/validate_palette.js` against
this app's *actual* chart surfaces (`#f7f2e2` / `#2b2015`), not the skill's
generic neutral defaults.

**A gradient must never fade toward the surface color** — this bit the app
twice from opposite directions and is worth knowing if a third heat-style
element gets added. `td.metric-heat` (the Income/Profit/Efficiency/
Population/Manpower/Black-Death-"Lost %" heat-fill cells) originally faded
alpha 0.65→0.3 left-to-right, which fades toward black on a dark surface
(fine) but toward *invisible* on light parchment (looks uncolored). Fixed by
keeping both gradient stops at high, near-equal alpha (0.9/0.75) and only
stepping *lightness* between them, with light and dark mode needing opposite
lightness directions (pale saturated fill + dark text vs. dark saturated
fill + light text) — `:root[data-theme="light"] td.metric-heat` overrides
the dark default. The Black Death "Lost %" column used to have its own
bespoke gradient (`lossPctColor()`, a hand-rolled green→neutral-gray→red
RGB lerp) for the same reason, before being folded into this same
`metric-heat` mechanism — `heatScoreFor()` gained a `col.lowerIsBetter` flag
(more population lost is worse, the opposite of every other heat column's
"higher is better"), and a single `heatColumn: true` flag on the column
definition was enough to opt in.

**Country-colored chart elements needed a contrast safety net.** The
Graphs-tab trend lines and the Llama Score leaderboard bars both color
themselves by the relevant country's real in-game color
(`country.color`, a `"rgb(r, g, b)"` string) rather than a generic
categorical palette — a nice touch (a player's own line/bar matches
their nation's map color) that can go wrong when a country's real color
happens to be too close to the chart surface's own color (a pale country on
light parchment, or a near-black one on the dark leather surface).
`legibleChartColor()` (`js/charts.js`) darkens (light theme) or lightens
(dark theme) a color only when its luminance is too close to the surface's,
leaving already-legible colors untouched; bars additionally get a hairline
border a fixed fraction darker than their own fill (`darkenColor()`) so they
stay visually defined regardless of how light or dark a given country's
color is.

**Ledger-mode leaderboards (a recorder-connected campaign, see the Llama
score section above) don't carry country color** — the recorder's compact
snapshot format (`llama-score-automatic-logging-machine/llama-log-machine.js`)
never stored it. Rather than change that separate standalone script,
`renderLlamaLeaderboardChart()` (`js/app.js`) falls back to looking the
color up by tag in whichever save is actually loaded in the browser tab
(`latestResult.countries`, always present, ledger mode or not) when the
leaderboard item's own color is missing.

**Gridlines snapped to round numbers.** Every chart's y-axis gridlines used
to be an even division of the padded data range (e.g. `22.7, 17.0, 11.3,
5.7, 0.0`), which is exactly what makes a chart read as an unstyled
spreadsheet default rather than something someone designed. `pickNiceTicks()`/
`niceStep()` (`js/charts.js`) snap to the nearest round 1/2/5/10 step instead
(`0, 5, 10, 15, 20`) — picks tick *values* within the chart's existing
scale/padding logic, not a change to the scale itself, so each chart's own
headroom-padding tuning is untouched.

**`assets/llama-logo-avatar.png` had a baked-in checkerboard, not real
transparency.** Some earlier export step had flattened a "transparent
background" preview checkerboard (two near-white grays, RGB ~254 and ~237)
into real opaque pixels rather than actual alpha — so `object-fit: cover` on
the (already-square) source didn't crop anything, and the *entire* canvas,
checkerboard included, rendered into the circular header logo, with the
character pushed to one side and a visible checkerboard patch filling the
rest. Fixed by flood-filling from the image's border pixels inward (not a
flat color threshold — that punched transparent speckle holes in the dark
hair, since a naive threshold also matches isolated same-colored pixels deep
inside the artwork that have nothing to do with the actual background) to
restore real alpha, then recentering the crop on the character's own content
bounds — keeping the *full* image height so the mane reaches the bottom edge
of the circle with no gap, rather than a centroid-only centering that left
one. The pristine original was recovered via
`git show HEAD:assets/llama-logo-avatar.png` after a first crop attempt
needed redoing, since it had already been committed.
`llama-dashboard/assets/llama-logo-avatar.png` is a separate
on-disk copy (confirmed via `md5sum`, not a symlink), so it needed the same
fix applied a second time.

**`llama-dashboard/renderer/style.css`** (the Electron desktop companion
app's own ~200-line stylesheet — no CSS file is shared between it and the
web app) was hand-ported to the same token values, border-radius, and
italic-serif treatment as `css/style.css`, so the two apps stay visually
consistent. Verified by opening `llama-dashboard/renderer/index.html`
directly via `file://` in headless Chrome — Electron's IPC calls silently
no-op outside an actual Electron process, but the static layout and CSS
render enough to check visually; exercising it against live recorder data
still needs an actual `npm start` launch.

**Verification method**, worth noting since no project-level run-skill or
`chromium-cli` existed here yet: every change in this section was checked by
actually launching a headless Chrome instance (the system Chrome install via
`playwright-core`, no bundled-browser download needed) against the real dev
server, loading one of the real saves under `save games/`, and screenshotting
each tab — not just reading the CSS. This is how the metric-heat fade-to-
invisible bug, the ledger-mode leaderboard color gap, and the logo's baked-in
checkerboard were actually found; none were visible from the source alone.

### Save history & shareable state

Uploading a save used to leave the dropzone and progress bar sitting there
indefinitely; a successful parse now collapses them into a compact
"Loaded: `<filename>` · Load a different save" bar (`js/app.js`, gated by a
`.dropzone[hidden]`/`.uploader-summary[hidden]` CSS rule — see the note
below on why that rule has to be explicit).

`js/save-library.js` keeps every parsed save in this browser's IndexedDB
(not `localStorage` — a parsed result, `locations` alone runs to ~28k
entries, is well past `localStorage`'s ~5-10MB quota). Each save gets a
stable id (`<playthrough_id>_<in-game date>`), so re-uploading the same
autosave under a different filename dedupes to the same library entry
instead of piling up duplicates. The "Recent saves" panel lists every save
this browser has processed, sortable by upload time or by in-game date
(via a derived `gameDateSort` numeric field — plain string comparison on
`"Y.M.D"` breaks on single- vs. double-digit months/days, e.g. `"1444.10.1"`
sorts before `"1444.9.1"` as text); clicking a row loads straight from
IndexedDB, skipping re-parsing entirely.

**Fixed: loading a save from history could silently show stale/incomplete
data with no indication why.** "Load" hands the *already-parsed* result
object straight to the UI — by design, that's the whole point (skip
re-parsing) — but that also means a save uploaded before some later parser
change (a new field, a bug fix that changes what a field means) permanently
lacks it in its cached copy, since the library only stores the parsed
result, never the original file bytes, so there's nothing to auto-recover
from. This bit twice in one session (once for a new Black Death field, once
for the province-owner-fallback fix above) before getting a real fix: a
`RESULT_SCHEMA_VERSION` constant (`js/app.js`) stamped onto
`result.__schemaVersion` at persist time, bumped whenever a parser change
adds/changes a field the UI depends on. Loading from history checks the
stamp, and on a mismatch shows a dismissable warning with a one-click
"Remove from history" button that deletes the stale IndexedDB record and
drops back to the upload screen, prompting a fresh re-upload — rather than
rendering the save as if nothing were wrong.

**Shareable link**, reconciled against "no server" (this app stays fully
client-side/static — see Hosted version in the Roadmap): a link can't hand
your save's data to someone who's never uploaded it, so this doesn't attempt
real cross-device sharing. What it does do is keep the URL
(`?save=<id>&tab=<load|metrics|graphs|llama|map>`) in sync with whatever's currently loaded, via
`history.replaceState`, and on load: if that id is in *this* browser's
library (the case that matters most - reopening a bookmark, or a link you
sent yourself on the same machine), it restores instantly instead of
dumping back to the blank uploader, which was the actual complaint driving
this (pdx.tools does the latter). If the id isn't found locally (a friend's
browser, or a save this browser hasn't seen), a specific prompt appears -
"This link is for a save from `<date>` - drop that save file in above to
view it" - rather than silently resetting; once the matching save is
uploaded, it jumps straight to the linked tab. "Copy link" sits next to the
tab nav.

**The `[hidden]`-attribute CSS gotcha, worth knowing if it bites again:**
setting `el.hidden = true` on an element whose own class already declares
`display: flex`/`block`/etc. does *not* hide it — the browser's UA
stylesheet rule `[hidden] { display: none }` and the author rule `.foo {
display: flex }` have equal specificity (0,1,0 each), and the later one in
cascade order (the author stylesheet) wins. `.status[hidden] { display: none;
}` already existed in `css/style.css` for exactly this reason; `.dropzone`
and `.uploader-summary` needed the same explicit override added once this
feature started actually toggling them (previously the dropzone was always
visible, so the bug was latent). Caught by an automated browser check (`.dropzone`
reporting non-hidden immediately after `dropzone.hidden = true`), not by eye.

## Running locally

Workers loaded via `importScripts` are unreliable under `file://`, so serve the
directory instead of double-clicking `index.html`:

```
python -m http.server 8000
# or: npx serve
```

Then open `http://localhost:8000`.

The map needs a one-time local setup (copying map assets from your own EU5 install
and running two data-prep scripts) since they're not committed to the repo — see
`map_data/README.md`. Without it, everything else still works; the map panel just
shows an error instead of rendering.

## Tests

```
node test/run.js <melted-save-path>            # text parser, prints a summary
node test/run-binary.js <compressed-save-path> <melted-save-path>   # full cross-check
```

`run-binary.js` needs both forms of the *same* save to diff against. `test/extract.js`
pulls the raw metadata/gamestate/string_lookup blobs out of a compressed save if
you need to inspect the binary format directly.

## Roadmap

- **Map polish.** Political, players, development, population, trade goods,
  religion, culture mapmodes; viewport-based zoom/pan; vassal shading;
  per-owner-colored player-nation outline; legends all work (see the Map
  section above). Still missing: aggregated named sea regions (currently
  per-location, not merged into "the Baltic Sea" as one hoverable thing) and
  culture/religion *names* instead of raw numeric IDs (see "Country display
  names" below — same underlying problem).
- **More stats + filtering.** Per-province development/population aggregation is
  now available (`result.locations`, one entry per location) and used by the
  Development/Population mapmodes; could still roll it up into country/region-
  level summary stats beyond what's already in the countries table. `war_manager`
  is now selectively parsed (see the Llama score section above); `unit_manager`
  (standing military composition, distinct from war participation) still isn't.
  The countries table has a wide set of economy/military columns now (income,
  expense, profit, efficiency, maintenance breakdown, army/navy size, GP rank,
  population, income-per-pop, tax-base-per-pop, location count, color swatch);
  a proper numeric-range filter UI (vs. the current text-search + column-sort)
  would make "filter by" more literal. Population/tax-base trend charts exist
  for current players (`js/charts.js`); could extend to any country, not just
  played ones, or add more series (development, army size) as toggleable
  overlays.
- **Country display names.** The save only stores tags (`country_name="SWE"` — the
  tag itself, not a localized name) and numeric culture/religion IDs; pretty names
  come from the game's localization files, which aren't safe to assume are present
  on a hosted deployment. Might bundle a static tag/culture/religion→name table.
- **Fixed-ID table maintenance.** Re-run `test/run-binary.js` against saves from new
  game patches as they come out; extend `js/eu5-fixed-ids.js` if new mismatches show
  up (same diff-against-melted-text method used to build it the first time, and the
  same position-alignment method used to find the `locations`/economy/military
  fields - see the binary-parser section above). Now validated against 1.0.8-1.3.10
  (59 of 59 real saves in the corpus parse cleanly).
- **Llama war-scoring.** Built - see the "Llama score (war scoring)" section
  above for the formula, the win/loss heuristic, and the manual-review UI.
  Remaining known gaps: the win/loss heuristic and the GP_Score field are both
  best-effort (flagged as such in the UI); war-to-player attribution can't be
  fully automated when a country changed hands mid-campaign, since
  `played_country` sessions carry no timestamp to line up against a specific
  war's dates (only the manual reassignment dropdown resolves that case).
- **Visual design.** Built - see "Visual design — the 'Campaign Ledger' reskin"
  above for the palette, the dark-mode-by-default toggle, and the chart-color
  fixes that came out of it. The other two mocked-up directions (a navy/brass
  instrument-panel "Chart Room," a warm-stone editorial "Field Report") are
  still available if a future pivot away from Campaign Ledger is wanted -
  neither was ever wired into the actual app, just mocked up for comparison.
- **Hosted version.** Netlify (static) + Supabase, matching the MSV2 setup. A
  fully local (no-server) version of save history and shareable/restorable
  view state now exists (see "Save history & shareable state" above) - it
  covers reopening a bookmark/link on the *same* browser, which was the
  actual motivating complaint, but not handing a save's data to someone who's
  never uploaded it themselves. Real cross-device sharing (send a friend a
  link and it just works, no local copy of the save needed) would still need
  this: Supabase to actually store/serve parsed saves, not just for the
  static hosting itself. The map needs a licensing decision before any hosted
  deployment happens, though: `map_data/` is Paradox's copyrighted map
  bitmap/data, currently kept local-only and out of version control (see
  `map_data/README.md`) rather than bundled for a hosted deployment to serve
  to visitors.
