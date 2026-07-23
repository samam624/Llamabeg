# Architecture & Implementation Notes

Technical deep-dive for contributors — how the save formats were reverse-engineered, how
the map renders, and how war scoring's winner-detection actually works internally, with the
validation behind each claim. For "what is this and how do I run it," see the root
[README.md](../README.md).

## Save format

EU5 saves start with a `SAV....` header line, then either:
- plaintext Clausewitz script (`SAV02` + `00` version code), or
- a binary-tokenized format (`SAV02` + `03` version code): a binary metadata block,
  followed by an embedded zip containing two deflate-compressed entries, `gamestate` and
  `string_lookup`.

Both are parsed entirely in-browser, with no external token table or server round-trip.

### Text parser (`js/clausewitz.js`)

A from-scratch streaming parser for the plaintext format. A full generic parse of an entire
save (500MB+) into JS objects would be too slow and memory-heavy, and 90%+ of the file
(military units, AI memory, character DB, war history, ...) isn't needed for summary stats.
So it walks the file once at the top level and, per top-level key, either fully parses it
(small sections: `metadata`, `played_country`), parses-and-immediately-discards each entry
(`countries.database` — one country object built and stripped down to the fields we want at
a time, so peak memory stays roughly proportional to one country block, not the whole
section), or skips over it without allocating anything (everything else).

The single generic block parser (`Scanner.parseBlockBody`) handles real-world quirks found
by testing against actual saves: blocks that mix bare array elements and `key=value` pairs
at the same level (`duration={ 1 0=255 }`), and tagged compound values like
`color=rgb { 0 104 166 }`.

### Binary parser (`js/clausewitz-binary.js`)

EU4's binary ironman format needs a secret, Paradox-maintained token table that isn't
published, but EU5 doesn't work the same way: each save carries its own `string_lookup`
table (a per-save string dictionary), so most field names and content strings are
self-contained. A smaller set of very common structural keys (a few hundred, shared across
Paradox's newer titles) use compact fixed 2-byte IDs instead — see `js/eu5-fixed-ids.js` for
the curated subset this tool actually needs (metadata, countries, players, locations, wars,
economy; not the whole schema).

The format was reverse-engineered by decoding the compressed save's binary structure and
cross-checking it, section by section and field by field, against the *melted plaintext of
that exact same save* (the game/pdx.tools can already melt saves). `test/run-binary.js`
codifies that validation permanently: it parses both the compressed and melted forms of the
same save and diffs every extracted field. Validated against 6 melted/compressed save pairs
spanning game versions 1.1.2–1.3.10 and both solo and 8-player campaigns (0 field mismatches
across 376,610+ field checks) and a corpus sweep of 59 real saves spanning 1.0.8–1.3.10 (no
thrown errors, sane country/player counts on all 59).

**Two-phase "tape" architecture** (rewritten 2026-07-23, matching
[jomini](https://github.com/rakaly/jomini) — the Rust parser PDX Tools itself is built on for
EU4/EU5/CK3/HOI4/Vic3/Imperator). The parser used to do one recursive pass that decoded bytes
and interpreted their *meaning* at the same time, so a wrong assumption about what a section
meant (e.g. "the true top level is always `key=value`") could corrupt byte alignment for
everything read afterward — a real save (274MB gamestate, 8 players, 2545 countries) hit
exactly this and silently came back with 0 players/wars/locations despite parsing 2542
countries correctly, because a large multiplayer campaign accumulates data shapes a short
solo reference save never exercises. Splitting into two phases makes that structurally
impossible:
- **Phase 1 (`tokenize`)**: one mechanical forward pass over the whole gamestate buffer with
  *zero* shape assumptions. Every token's width comes purely from its own 2-byte type tag
  against a complete value-type catalog — never from "what key/section is this." Produces a
  flat, self-describing tape (parallel arrays: kind, decoded value, byte offset, matching
  bracket index).
- **Phase 2 (the section parsers)**: walks that tape *by index*, not by byte offset. A wrong
  shape assumption here can at worst misread one section's meaning — it can no longer corrupt
  alignment for anything downstream, because phase 1 already guarantees every tape index lands
  on a real token boundary.

The ~13 near-identical section parsers (`parseCountriesSection`, `parseLocationsSection`,
`parseWarManagerSection`, ...) were each hand-rolling the same "peek CLOSE, resolve key,
expect EQUALS, recurse into `database={n={...}}`" boilerplate; migrating them onto the tape
cursor was also the natural point to consolidate that into two shared helpers (`walkSection`,
`walkDatabase`) — a net reduction in code, not an addition, as a direct byproduct of the
migration rather than a separate cleanup pass.

Trade-off: tokenizing the whole buffer up front (rather than only the bytes phase 2 actually
visits) costs real time/memory on a large save — roughly 2x slower and ~2x more peak memory
than the old lazy-walk architecture on a 274MB gamestate (~7.8s / ~690MB RSS with every
extraction option on, vs. ~3-6s before). Considered acceptable for the robustness gained;
typed-array tape storage and lazy string decoding (matching jomini's own zero-copy
`Scalar<'a>` design more closely) are available follow-ups if this ever becomes a real
bottleneck.

Key encoding details worth knowing if this needs revisiting:
- A "key" token can be a fixed 2-byte ID, a `string_lookup` reference (2 bytes + 1-3 byte
  index — used for keys too, not just values), an inline Hollerith string (`0x000f`/`0x0017`
  — pre-1.1 saves spell some keys out in full instead of using a `string_lookup` ref), or an
  int32-coded token (used for numeric map keys like `countries.database`'s country numbers).
  There are two distinct 1-byte-index `string_lookup` ref codes, `0x0d40` and `0x0d43` — the
  second only shows up on pre-1.3 saves.
- Fixed-point values (`0x0d48`-`0x0d56`, variable 1-7 byte width) are `raw / 100000`, *not*
  `/10000` as the EU5 wiki's save-game-editing page states for the format in general —
  confirmed by cross-checking decoded currency/score values against melted text.
- Dates are hours since year -5000, ignoring leap years:
  `((year + 5000) * 365 + julian_day) * 24 + hour`.
- Telling a map/array **key** apart from a **bare value** requires fully resolving the token
  first, not just peeking 2 bytes ahead for the `=` marker — a payload-bearing type (fixed-
  point, bool, string) appearing as a bare array element can have its own bytes coincidentally
  look like an unmapped key, desyncing the rest of the section if the peek lands mid-payload.
  `resolveToken`'s fallback delegates straight to `readScalarValue` (the same function
  `skipBareValue`/`readBareValue` already use for values) so every recognized payload type is
  *fully* consumed before the `=`-peek runs, on both the key path and the value path.
- A `countries.database` entry isn't always a full country object — some are a bare enum
  value (a tombstone for a merged-away country). Excluded via a sentinel-shape check rather
  than assuming "value is an object" means "value is a country."
- `0x0d47` is a dedicated "value is exactly 0" code, not an unmapped fixed ID — found because
  fields like `expected_army_size` decoded to a phantom placeholder object instead of `0` on
  exactly the countries where melted text had `0`.
- `0x029c` (used by a monotonically-growing counter in `situation_manager`) is an 8-byte
  integer, not 4 bytes like its apparent siblings `0x000c`/`0x0014` — misreading it as 4 bytes
  left 4 real payload bytes unconsumed, desyncing the rest of the file and silently producing
  a "0 countries, no error" result. Fixed by giving `0x029c` its own 8-byte case in
  `readScalarValue`/`skipScalarValue`/`resolveToken`.
- The value-type catalog was missing 5 real codes entirely until 2026-07-23, found by
  cross-checking against jomini's own token table rather than guessing: `I64` (`0x0317`, 8
  bytes — the same "wider sibling" trap as `0x029c` above, just a code no reference save had
  ever been large enough to exercise), `F32` (`0x000d`, 4 bytes), the 3-byte and 4-byte
  `string_lookup` ref widths (`0x0d41`/`0x0d3f` — needed once `string_lookup` exceeds 65,536
  entries, which a long multiplayer campaign's easily does), and a dedicated empty-string code
  (`0x0d42`). Every one fell through to the "unresolved token, zero payload bytes" default,
  silently under-consuming real payload.
- `0x0001`/`0x0003`/`0x0004` (EQUALS/OPEN/CLOSE) are **not exclusively** structural control
  codes — the format also reuses them as bare opaque enum values in specific fields (byte-
  verified: `population.database`'s per-pop `pop_demand` array has a literal EQUALS-coded
  element with no key before it, and a field elsewhere does the same with a CLOSE-coded one).
  They're structural *only* at the specific points that explicitly check for them (right after
  a resolved key, or before ever resolving a token at all) — anywhere else a token gets
  resolved as a bare value, all three must fall back to the same opaque `{fixedNum: code}`
  sentinel every other unmapped code gets, not throw. Easy to get wrong when rearchitecting:
  the tape rewrite above initially treated these three as unconditionally structural and broke
  on real saves until this was found.
- The true **top level** of `gamestate` isn't always strictly `key=value` either — a real save
  was found with a long run of bare, unkeyed records (`{target=... start_date=...
  expiration_date=...}`, accumulated diplomatic timers a short solo game never generates
  enough of) sitting right after `diplomacy_manager`. The nested walker already tolerated bare
  array elements everywhere; the top-level loop didn't, and silently gave up the instant it
  saw one, discarding every section after it. Same tolerance now applies at every depth,
  top level included.

Deflate decompression uses the browser's native `DecompressionStream('deflate-raw')` (falls
back to Node's `zlib` when running under `test/`) — no bundler, no external zip/inflate
library.

**Caveat:** the fixed-ID *key* table was derived from saves on game version 1.3.10 and
validated back to 1.0.8. Paradox could still add new fixed IDs in future patches (probably
additive, not renumbered, going by how EU4's equivalent token space has behaved historically,
but unverified for EU5). An unrecognized *key* still degrades gracefully to a `#hex`
placeholder — that part didn't change tonight. The *value-type* catalog (the 2-byte codes that
determine a payload's byte width — `0x000c`/`0x0317`/`0x0167`/etc., a completely different,
much smaller table from the fixed-ID key names) is a different story: as of 2026-07-23 it's
been cross-checked complete against jomini's own reference catalog (see the two-phase tape
section above), which is the part that actually matters for not desyncing — an unrecognized
*key* degrades gracefully by design, but an unrecognized *value type* used to desync
everything downstream of it, silently. Worth checking `test/run-binary.js` against a save
from a new patch before trusting results from it either way.

`test/debug-desync*.js` and `test/debug-anomaly-scan.js` predate the tape rewrite and are
stale — they assume `dec.pos` is a byte offset (it's now a tape index post-rewrite) and hunt
for exactly the value-width desync class the tape architecture now rules out structurally. Not
deleted (harmless as historical reference for the debugging *technique*), but don't trust
their hardcoded byte-offset constants or expect them to run against the current decoder
without adaptation. If a *new* silent-empty-result bug ever shows up, see the
`diagnose-eu5-binary-parser-desync` skill for the up-to-date methodology (bisect the
suspect section with a debug-enabled tape cursor, compare against jomini's catalog for a
missing/misrouted token, don't assume `test/debug-desync*.js` still applies as-is).

For context on how much more robust this needs to be regardless: even `rakaly/jomini`, the
library behind pdx.tools, explicitly disclaims full cross-patch compatibility for the same
reason — there's no shortcut around it for a closed-source, undocumented format.

**`locations.locations`** (per-location owner/controller/development/culture/religion/
raw_material/tax — needed for the map) and a large batch of country fields (`economy` and
its sub-fields, `color`, `great_power_rank`, `expected_army_size`/`expected_navy_size`,
`owned_locations`, maintenance/expense breakdowns, etc.) were added the same way: parse a
save both ways, dump one object's keys from each parser side by side, and read off which
`#hex` placeholder lines up with which real field name.

**`war_manager` and its `database` entries** (for war scoring): resolved by position
alignment at the top level — both formats have exactly the same number of top-level keys in
the same order for a given save, so `war_manager`'s index could be read straight off the
melted text's top-level key list and matched to the same-index unresolved key in a binary
walk. Inside `war_manager.database`, field IDs for `all`, `history`, `request`, `reason`,
`join_type`, `side`, `revolter`, `called_ally`, `joined`, `left`, `original_attacker`,
`original_attacker_target`, `original_defenders`, `revolt`, `previous`, `start_date`,
`end_date`, `war_goal_held`, `attacker_score`, `defender_score`, and `names` were derived by
decoding known war entries (matched across formats by war number, which is cross-format-
stable) and reading off key order against the already-understood melted-text dump of the
same war. Pre-1.3 saves omit `war_manager`'s `names` sub-block entirely.

`revolter=Yes` (capital Y) is a *different* token from the `yes` boolean literal the text
parser's `coerceScalar()` lowercases elsewhere — it arrives as the literal string `"Yes"`,
not `true`; `extractWarFields` checks both spellings. Binary dates inside a war entry
(`start_date`/`end_date`/per-participant `joined.date`/`left.date`) arrive as raw hour
counts needing the same `dateFromHours()` conversion used elsewhere.

## Map (`js/map.js`, `map_data/`, `tools/`)

Renders a pdx.tools-style province map with toggleable mapmodes (political, players,
development, population, RGO, religion, culture), mouse-wheel zoom, drag-to-pan, and
hover tooltips, using the game's own map bitmap plus per-location data pulled from the save.

- **Sea vs. land.** `default.map`'s `sea_zones`/`lakes` lists mark each location as water or
  land; water always renders as blue regardless of mapmode, and a coastline is drawn wherever
  a water/land boundary crosses a pixel, so unowned/unclaimed land still reads as a continent
  instead of disconnected color specks.
- **Player nations get a thick outline**, drawn on top of any mapmode, colored with a dark
  shade of each side's own political color (via `shadeColor`) so two adjacent player nations'
  shared border reads as visibly two-toned.
- **"Shade vassals by overlord"** toggle colors a subject's locations as a shade of its
  overlord's color, using the same subject/overlord data as the political tooltip. Multiple
  vassals of the same overlord get different deterministic shade offsets.
- **RGO** mapmode colors by each location's `raw_material` string (hashed to a color,
  since goods aren't numeric IDs).

Since (unlike EU4's `definition.csv`) EU5 ships no color→ID table for `locations.png`, that
mapping was pieced together from three separate files:
- **Location numbering** (matching the IDs the save format itself uses) is the 1-based order
  locations appear when flattening `definitions.txt`'s nested continent/region/area/province
  tree — confirmed against real save data: location #1 in that ordering is `stockholm`, and
  Sweden's `capital` field in a real save is `1`.
- **Name → color** comes from `named_locations/00_default.txt` (documented on the
  [EU5 modding wiki](https://eu5.paradoxwikis.com/Map_modding), not in the shipped file
  structure itself).
- All 28,573 locations resolve to a unique color, matching `locations.png`'s actual
  unique-color count exactly; geographically sanity-checked (`stockholm`'s pixel blob sits
  directly adjacent to `norrtalje`'s).

`tools/build-location-data.js` and `tools/bake-location-id-map.py` turn that into
`map_data/locations.json` (id → name) and `map_data/location_ids.png`, a derived
16384×8192 image where pixel R+G channels directly encode the location ID — a data-only
transform of the game's map, not a copy of Paradox's artwork. The raw `locations.png`/
`definitions.txt`/`named_locations/` are Paradox's own copyrighted files and are never
committed or served (see root README's "Map setup") — but those two *derived* files are
committed and are shipped to `dist/` (`scripts/build-netlify-site.js`), a deliberate call
made after weighing Paradox's fan-content terms (free, non-commercial - both true here) and
the pdx.tools/Skanderbeg precedent of long-running public Paradox-game maps, versus the
absence of an explicit written rule covering this exact case either way. `js/map.js` fetches
both with a `?v=` cache-busting query string (`MAP_DATA_VERSION`) and `netlify.toml` caches
them `immutable` for a year - bump `MAP_DATA_VERSION` whenever `map_data/` is regenerated and
redeployed, or a visitor's browser won't pick up the change.

`colorFor()` runs once per *unique* location id to fill a flat `Uint8ClampedArray` lookup
table (`buildLUTs()`); the actual per-pixel work is an array index into that LUT — too slow
otherwise over 134M source pixels (16384×8192).

**Rendering is viewport-based, not full-world.** `renderViewport()` computes which source
rectangle is currently visible and renders only that, into a canvas sized to the viewport's
own CSS box (× `devicePixelRatio`, capped at 2) — typically a few million pixels, not 134M.
Border/coastline detection compares already-downsampled *destination* pixels, so the line is
a consistent ~2–3 screen px wide at any zoom level. `playerOwnedLUT` walks the `dependency`
overlord chain (capped at 8 hops), so a player's vassals are inside their border too.

Coordinate mapping: `view = { scale, offX, offY }` is a source→screen affine, initialized to
a "contain" fit (`computeFit()`) and updated directly by wheel-zoom/drag-pan. Pan/zoom
re-renders are throttled through `requestAnimationFrame`. A `ResizeObserver` on the wrap
re-clamps and re-renders on container resize.

**Ownership is tracked at two levels in EU5**: `locations.locations.<id>.owner` (per-
location) and `provinces.database.<n>.owner` (a coarser grouping, several locations per
province). A location's own owner field can be completely blank while its containing
province has a real owner — confirmed on real saves (a populated city with only
market-graph fields and no `owner=` at all, while its province had a real owner). The
in-game client and third-party tools read ownership at the province level; this app now
does too, via `applyProvinceOwnerFallback()` in `js/map.js`, which fills in a blank
location owner/controller from its province right after `locations.json` loads — mutating
`result.locations` in place so every consumer (map fill/borders, detail panels, tooltips,
country table location counts) sees the corrected value. On a real save this affected
~10% of all locations (2,389 of 28,573).

## Subject/overlord relationships (`dependency` records)

Vassals, tributaries, dominions, etc. aren't a field on the country object — they live in
`diplomacy_manager`, mixed in among a much larger per-country-pair trust/rivalry section, as
repeated `dependency` entries: `{ first=<overlord number> second=<subject number>
named_targets={{ flag=subject_type target={ object=vassal|tributary|dominion|... } }} }`.
Both parsers walk `diplomacy_manager` selectively and extract just these into
`result.dependencies`. Validated: 431/431 dependencies match exactly between the binary and
text parse of the same save, covering 10 distinct subject types (vassal, dominion,
tributary, fiefdom, hanseatic_member, tusi, appanage, secessionists, maha_samanta,
state_bank).

## Player-session history

`played_country` entries accumulate one per session — reconnects, and (in a long-running
multiplayer campaign) a different human taking over an existing seat entirely. There's no
timestamp on these, but they're written in a stable order that does reflect recency, so only
the *last* entry per country is kept as that country's current controller. A player who's
stopped showing up for good but hasn't been replaced by anyone else has no distinguishing
signal in the save at all (it's a snapshot of game state, not a connection log) — that case
is a manual "Hide" button per player row, persisted in `localStorage`.

Both parsers also keep the *uncollapsed* history as `result.playerSessions` (every
`played_country` entry, not just the last per country) for war scoring, which needs to know
every human who's ever controlled a country to offer as a manual reassignment option. A
country with more than one historical player is flagged "ambiguous" and defaults to its
current controller; the actual call is left to the review table, since there's still no
timestamp to line a session up against a specific war's known start/end dates.

`collapsePlayerSessions()` (shared by both parsers) also handles a player who abandoned one
country for another with nobody ever taking over the old one: group the per-country-
collapsed list by player name, and for any name still controlling more than one country,
keep only the one whose session is most recent in file order and drop the player from the
older country entirely.

## Economy/military fields and trend charts

`color`, `economy` (income/expense/creditworthiness/monthly_gold), `great_power_rank`,
`expected_army_size`/`expected_navy_size`, `last_months_population`,
`historical_population`, `historical_tax_base`, `historical_economical_base`, and
maintenance/expense breakdowns were added to `extractCountryFields` and derived by the same
position-alignment method as the locations fields. `js/app.js` derives a few more metrics
client-side: profit (income − expense), efficiency (profit ÷ income), and income/tax-base
per population.

`js/charts.js` renders the Trends line charts (population, tax base over time), one line
per current player. `historical_population`/`historical_tax_base` aren't the same length
for every country (a nation formed or released partway through the campaign has fewer
yearly entries) — the shared year axis is sized to the *longest* history among the current
players and every series is right-aligned to it, since each array's *last* entry is always
"now" regardless of length.

`lastMonthGoldIncome` falls back to `economy.income` whenever the primary
`last_month_gold_income` field is absent (confirmed missing on some pre-1.1 saves, not a
parsing bug) — cross-checked on a newer save where both exist and track within ~1-2% of
each other.

**Trade Income and Tax Income** (Economy tab) both come from `estate_manager.database`, which
mixes two record shapes under one numbering: real location assets (RGOs/buildings/roads) and,
separately, one summary entry per country per estate type (nobles/clergy/burghers/…) carrying a
`last_month` breakdown. Both columns sum a field of that summary across a country's estates, but
they're *not* equally trustworthy: `paid_taxes` (→ Tax Income) is the real gold the estate sent
the crown and lines up with the government ledger's per-estate "Tax at X% from &lt;estate&gt;"
lines, whereas `trade_income` (→ Trade Income) is each estate's own *private* trade wealth (it
feeds the estate's separate `gold`/`balance` pool) and is only a best-effort proxy for the
ledger's own "Trade Income" — summing it alongside Tax Income for one test country already
exceeded that country's entire Gross Income, so the two can't both be simple additive
components. Trade Income's column/tooltip say so; Tax Income was sanity-checked at or under Gross
Income for 1,705 of 1,707 countries on a real save.

**Base Tax and Economic Base** (Economy tab, Base Tax also on Key) read the *last* entry of
`historical_tax_base` / `historical_economical_base` respectively (always "now"), not a
dedicated current-value field: `current_tax_base` exists only on pre-1.3 saves (dropped by
1.3.x) and `current_economical_base` never existed, so the historical arrays are the only
version-stable source. `historical_economical_base` is itself newer (absent pre-1.3), so
Economic Base is blank rather than wrong on an older save. A country's **"Wealth"** (the
line the in-game Economic Base breakdown shows contributing at ~0.5×) is *not* stored
anywhere — the game derives it live from population/estates/subjects at render time (the only
`wealth`-named fields in a save are per-estate `wealth_impact`, which sums to ~7 per country,
and per-estate `gold` treasuries, which sum ~9× too high) — so it's deliberately not offered;
Economic Base is the stored aggregate it feeds.

### Troop headcounts vs. regiment counts (`subunit_manager`)

The Military tab's Navy Size and the "Active Regiments / Levy Regiments / …" columns are
*counts* of `subunit_manager` entries (see "war_manager"-adjacent notes above for how army
subunits are told apart: army types carry an `a_` prefix, naval `n_`, and the same section
mixes in unrelated estate/religion/union entries filtered out by that prefix). The **"Active
Army (k) / Levies (k) / Regulars (k) / Mercenaries (k)"** columns show real troop headcounts
instead, and the save already carries them: a regiment's own **`strength` field IS its
current troop count**, in the same "thousands" unit the app uses for population/manpower
(`strength=0.40` = 400 men) — *not* a 0-1 fill fraction. Proven two ways against a real save:
a Byzantine cataphract at `strength=0.40` shows as exactly 400 men in the in-game unit panel,
and across 2,003 regiments `strength*1000` never exceeds that unit type's own max capacity,
landing exactly at it for the full ones. So the "(k)" columns are just the per-country sum of
`strength` — no unit-size table, no game-install files, works on the deployed site directly.

Two encoding subtleties, both learned the hard way:
- `strength` is *not* a fill fraction to multiply by a separately-derived max unit size. That
  approach double-counted and read ~2.5× low, and briefly required a whole tool that read
  `max_strength` out of the game's own `unit_types` defines (walking `copy_from` chains, with
  the +size bonuses that accumulate *additively* up the chain — e.g. a Varangian Guard inherits
  500 and adds its own 100 to reach 600). That tool is deleted; none of it is needed once
  `strength` is understood as the count itself.
- An **absent** `strength` field marks an **unraised levy** (0 mustered troops), not a full
  regiment. Confirmed: all 179 of 1939 strength-less subunits in one save were levies (never
  built regulars, which always carry an explicit strength) — each an allocated-but-not-gathered
  levy that has its `levies={…}` pop list but no `experience` and no strength yet. It
  contributes 0 to the current-troop sum. (`extractArmySubunit` defaults absent strength to 0
  for exactly this reason.)

## Black Death analyzer

Ranks countries by population lost to the Black Death. `situation_manager.<name>` tracks
~20 scripted historical events by name (`black_death`, `hundred_years_war`, `sengoku`,
...), and `black_death.status`/`.start`/`.end` give the exact date range once it's fired.

**Per-country death counts are read directly, not a population-before/after diff** — a diff
would also capture unrelated land gained/lost during the outbreak window (conquest,
colonization), and can even go negative for a country expanding faster than it's dying.
`disease_outbreak_manager.data[]` (one entry per disease type ever seen) carries a
`countries` sub-list of `{county, deaths: [{disease_outbreak, deaths}]}` — a running
per-country death tally attributed to whoever owned a location at the moment of each death,
split per distinct outbreak instance (only the id matching `situation_manager.black_death`'s
own pointer counts as "the" Black Death). This is the same number the in-game "disease
breakdown" UI reads. Both parsers implement this as a selective walk, skipping the much
larger per-location resistance/immunity blob and only materializing the `countries`
breakdown.

`renderBlackDeath()` shows Tag / Player(s) / Population (start) / Black Death Deaths / Lost
% = deaths ÷ population-at-start, color-graded green (least lost) to red (most), scaled to
the loaded save's own min/max rather than a fixed 0–100% axis.

## Llama score (war scoring)

Port of a multiplayer EU4 scoring spreadsheet to EU5, driven by `war_manager` data. For each
player: `LlamaPoints = GP_Score/100 + Σ(war scores)`.

- **GP Score**: `(27 − Great Power Rank + 1) × 75`, floored at 0 for rank 28 and below —
  `great_power_rank` is present from game start in every save (unlike prestige-based
  alternatives, which only activate in a later era) and calibrated against a real
  game-computed tier boundary.
- **War Score**, per finished war: `10·E·W/(A+1) + 10·(W−1)·(A+1)/(2·E)` (or `2·C·(2W−1)`
  when `E=0`, a condottieri contract with no direct enemy), where `E` = distinct enemy
  countries, `A` = distinct allied countries excluding self, `W` = 1 if won else 0, `C` =
  condottieri flag. In PVE mode, a vassal/subject fighting alongside its own overlord on the
  same side doesn't count as a separate Enemy or Ally (beating "the Ottomans + 3 vassals"
  scores the same as beating just "the Ottomans") — a vassal fighting entirely on its own
  still counts normally.
- **Llama Points** (PVP mode) and **Alpaca Points** (PVE mode) are the exact same formula,
  just labeled differently so the two leaderboards are never confused for one another —
  PVE additionally drops GP Score from the total (it's a world-standing/economic baseline
  unrelated to how well someone's doing against AI specifically).

### How a winner is decided

EU5 clears `attacker_score`/`defender_score`/`war_goal_held` once a war concludes, and
participant status/left-reason is identical for winners and losers alike — no clean
win/loss field survives in the save. `js/llama-score.js`'s `inferOutcome()` reconstructs a
winner from whatever *does* survive, in a strict priority order, and **only three signals
are ever allowed to crown a winner**:

1. **War reparations enforced** — an indemnity obligation recorded in
   `diplomacy_manager.war_reparations`, read directly from the peace treaty rather than
   inferred (the payer is the loser, the receiver is the winner). The single strongest
   signal available, since it isn't a before/after comparison at all.
2. **Independence granted** — a war whose internal goal is literally "gain independence"
   (`war.warName === "INDEPENDENCE_WAR_NAME"`) is decided by whether the vassal is still
   subjugated to one of the war's original defenders by the time it disappears from the
   save. Land/gold rarely change hands in an independence peace, so without this signal
   these wars would incorrectly fall through to White Peace despite being completely
   unambiguous.
3. **Land transfer** — a real *before-vs-after* territory comparison between the war's two
   original sides (not just anyone dragged in as a coalition member). Requires both
   sides to show genuine, oppositely-signed location deltas (or a real nonzero delta on
   the only side with data) — a side sitting at exactly 0 doesn't count as "opposite" of
   whatever the other side's unrelated change happens to be, which guards against
   misattributing land from a different, unrelated war/colonization in the same snapshot
   window. Falls back to a coalition-wide (whole-side, less certain) reading when no clean
   1-on-1 principal data is available.

**Deliberately not decisive, no matter how one-sided:** the in-game war score at
conclusion, battle/capture casualties inflicted, who's occupying more contested territory
at the moment the war disappears, treasury swing, and prestige swing. Real campaign data
repeatedly produced false positives from each of these even after tightening thresholds — a
winning invader can still take heavy battle losses; occupying land mid-war isn't the same as
keeping it once the peace is signed (occupation alone called the wrong side on 4 of 5 real
wars checked, even as the *primary* signal in an earlier design); treasury and prestige both
swing for reasons that have nothing to do with who won this specific war. All of these are
still computed and shown as **contributing factors** in the war detail view — auditable,
just never trusted to pick a side by themselves, not even when several happen to agree.

**If none of the three decisive signals fire, the war scores as a White Peace** (0 for both
sides) rather than guessing. This is the expected outcome for a war fought entirely through
allies with no territory, reparations, or independence resolving between the two original
sides — not a bug, and not a sign the algorithm gave up; a per-war manual override in the
"Edit war corrections" modal exists precisely for the case where a human reviewing the
in-game history knows better than the available data.

Confidence on a decisive call shifts up one level if the battle-losses lean agrees with it,
and down one level if the war visibly stalled 2+ years without movement.

### Single-save vs. campaign-ledger mode

Loading just one save with no recorder ledger connected gives the scoring engine no
"before" snapshot to compare against — there's nothing to diff a war's territory/reparations
state against. In that mode, `computeLlamaScores()` falls back to a much rougher guess:
whichever side is occupying more of the war's contested locations *at the moment the save
was taken*. This is the same category of signal explicitly excluded from ledger-mode
decisions above, for the same reason — treat single-save Llama Score numbers as a rough
estimate, not the real thing.

**This is the main reason to run the Dashboard/recorder at all.** Connecting a campaign
ledger (`computeFromLedger()`) switches every concluded war over to the reparations/
independence/land-transfer detection described above, because the recorder captures a
snapshot immediately before and after each war disappears from the save — the before/after
comparison the decisive signals need, which a single save can never provide on its own. It
also catches wars that EU5 purges from `war_manager` faster than a typical autosave
interval, which would otherwise go straight from `active` to *gone* with no snapshot ever
showing them as concluded.

### What makes an outcome "recognizable"

- **Conquest wars** — one side's territory measurably shrinks, the other's grows — are the
  single most reliable case, and don't need anything else to line up.
- **Indemnity peaces and independence wars** are equally reliable and need *no* territory to
  change hands at all, since both are read from a direct peace-treaty fact.
- **Wars where none of the above happens** — fought entirely through allies/vassals, or
  ending with nothing actually changing hands between the two original sides — fall to White
  Peace by design, even if the in-game war score or battle losses "look" one-sided. Check the
  contributing-factors tooltip on that war's row if this looks wrong for a specific war you
  remember clearly, and correct it manually.

### Auto-exclusion

A war row is automatically excluded from a player's score (shown with an `auto` badge and a
reason on hover) rather than counted, when:

| Reason | Meaning |
|---|---|
| `vs-ai` | No country on the opposing side was ever player-controlled — not a PvP result. |
| `vs-player` (PVE mode only) | The opposing side had a real player, so this isn't a PvE/Alpaca-Points result. |
| `player-departed` | The scored player had already stopped controlling this country (reverted to AI) *before the war even began*. |
| `opponent-departed` | Every enemy in the war had already left the campaign *before the war even began* — fighting an abandoned, AI-reverted country scores for no one. |
| `no-battle-losses` (PvP only) | This country never recorded a Battle/Capture loss in the war — joined but never actually fought, so it doesn't count as an enemy/ally for anyone else's score either. |
| `player-hidden` | The player was manually hidden via the Players table's Hide button. |

**Both departure checks key off the war's START date, not its end.** A player (or their
opponent) who was actively in control when a war began and only left partway through it
fought a real fight, and that war still counts in full for/against them — departure only
excludes a war that didn't even begin until after they'd already left for good. An earlier
version checked the war's *end* date instead, which wrongly zeroed out a war's entire score
the moment either side disconnected anywhere near its conclusion, even after playing out the
whole thing up to that point.

Departure detection (`buildControlTimeline()`) walks every recorded ledger snapshot in date
order and builds a real per-country control timeline, so a country that changes hands more
than once over a campaign is handled correctly — an earlier design that tracked only "as of
the latest snapshot" silently un-excluded genuinely-abandoned wars the moment a later
reconnect happened. Every exclusion is overridable per-war in the "Edit war corrections"
modal; a manual override always wins over the automatic read.

## Ocean/lake caveat

Sea/lake classification is per-*location*, not aggregated into named bodies of water (the
Baltic Sea's dozen-plus constituent zones each render as separate same-colored patches, not
one labeled region) — good enough for the coastline outline and blue fill, not for a "hover
the Mediterranean, see its name" feature.

## UI structure

`js/parse-worker.js` runs the parse in a Web Worker so the page doesn't freeze on large
files; `js/app.js` falls back to the main thread if Workers aren't available (e.g. some
`file://` contexts).

Tabs: **Home / Load Save / Metrics / Graphs / Llama Score / Map** (`index.html`'s `#results`
nav, `js/app.js`'s `tabPanels`/`activateTab`). Load Save is the only tab shown pre-load
(`setResultTabsAvailable()`); loading a save auto-jumps to Metrics if you were on Load Save,
but doesn't yank you away from Map/Graphs/Llama if you were already looking at something
else.

## Visual design — the "Campaign Ledger" reskin

Parchment background, wax-seal red accent, gold-tan hairlines, italic serif headers,
monospace numeric columns. Everything routes through a `:root` CSS custom-property set
(`--bg`, `--panel-bg`, `--panel-border`, `--text`, `--accent`, `--good`, `--bad`, `--gold`,
`--font-mono`) — no build step, no CSS framework.

Dark mode is the actual default (`:root` itself holds the dark palette), with
`:root[data-theme="light"]` as the opt-in daytime override. A theme toggle in the header
stamps `document.documentElement.dataset.theme` and persists it to `localStorage`; an inline
`<script>` in `<head>` applies any saved choice synchronously so a returning visitor never
flashes the other theme first.

The map's floating panels (toolbar, legend, tooltip, detail panels) stay a fixed
warm-brown-black HUD regardless of page theme — scoped `--text`/`--accent` overrides on
those container selectors, picked up automatically by every descendant through CSS
inheritance.

`js/charts.js` reads its palette from CSS custom properties at render time
(`chartTokens()`), rather than hardcoding a parallel JS palette that could drift from the
CSS one. Chart elements colored by a country's real in-game `color` (trend lines, the Llama
Score leaderboard bars) get a contrast safety net (`legibleChartColor()`) that darkens/
lightens a color only when it's too close to the chart surface's own color.

`llama-dashboard/renderer/style.css` (the Electron desktop companion app's own stylesheet —
no CSS file is shared between it and the web app) is hand-ported to the same token values,
border-radius, and italic-serif treatment, so the two apps stay visually consistent.

### Home tab hero backdrop

The Home tab's title card sits over a political-map image (a colorized crop of Europe/the
Mediterranean from one reference campaign) with the same darkening/vignette CSS treatment as
the rest of the "Campaign Ledger" look. This used to be rendered live in the browser on every
page load: `js/app.js` fetched `map_data/location_ids.png` (the per-pixel location-id image
also used by the interactive Map tab) plus `assets/home-political-snapshot.json` (a small
per-location ownership snapshot from one chosen save, built by
`scripts/build-home-political-snapshot.js`) and recolored it per-pixel on a canvas.

That's exactly why it couldn't ship at the time this was built: `map_data/` wasn't bundled
into `dist/` at all yet (the interactive Map tab's own derived files weren't being shipped
either — see "Map" above for when/why that changed). Even now that `location_ids.png` does
ship, the backdrop stays a static bake rather than switching back to live rendering: it's
purely decorative and never reflected whichever save a visitor has loaded (it always used one
fixed reference campaign), so nothing dynamic is gained by paying the runtime cost of
per-pixel canvas work and an extra `assets/home-political-snapshot.json` fetch on every visit,
when a single baked image looks identical. `tools/bake-home-hero.js` drives a real browser
(Playwright) through the exact same crop/colorize/boundary-line algorithm the old
`drawHomeMapBackdrop()` used, and writes the flattened result to `assets/home-hero-map.jpg` —
a single picture, not per-pixel location-id data or any of Paradox's original map art, so it's
safe to commit and ship. `index.html`'s Home tab is now just a static `<img>` pointing at that
file, with the same `.home-map-canvas` CSS filter and `.home-fog` overlay as before providing
the mood — no runtime fetch, no per-pixel JS, no `map_data/` dependency at all.

Re-run `tools/bake-home-hero.js` (needs local `map_data/` and
`assets/home-political-snapshot.json` — the same local-only setup the interactive Map tab
needs) and commit the new `assets/home-hero-map.jpg` to feature a different campaign or crop.

## Save history & shareable state

`js/save-library.js` keeps every parsed save in the browser's IndexedDB (not
`localStorage` — a parsed result can run to tens of thousands of entries, past
`localStorage`'s ~5-10MB quota). Each save gets a stable id
(`<playthrough_id>_<in-game date>`), so re-uploading the same autosave under a different
filename dedupes to the same library entry. A `RESULT_SCHEMA_VERSION` stamp on each cached
result detects when a parser change adds a field the UI now depends on, and prompts a
re-upload instead of silently rendering stale/incomplete data.

The URL stays in sync with whatever's loaded (`?save=<id>&tab=<load|metrics|graphs|llama|map>`)
via `history.replaceState`. If the linked save id is in *this* browser's library, it restores
instantly; if not (a friend's browser, or a save this browser hasn't seen), a prompt asks for
that save file rather than silently resetting to the blank uploader.

## Roadmap / known limitations

- **Map**: no aggregated named sea regions (currently per-location, not merged into e.g. "the
  Baltic Sea" as one hoverable thing); culture/religion show as raw numeric IDs, not names
  (see "Country display names" below).
- **Country display names**: the save only stores tags (`country_name="SWE"`) and numeric
  culture/religion IDs; pretty names come from the game's localization files, not safe to
  assume present on a hosted deployment. A bundled static tag/culture/religion→name table
  would fix this.
- **Fixed-ID table maintenance**: re-run `test/run-binary.js` against saves from new game
  patches as they come out; extend `js/eu5-fixed-ids.js` if new mismatches show up (same
  diff-against-melted-text method used to build it).
- **Llama war-scoring**: the win/loss detection above is validated against real campaign
  data but still fundamentally inference over an undocumented format — treat it as
  best-effort, with the manual per-war override as the safety valve. War-to-player
  attribution can't be fully automated when a country changed hands mid-campaign, since
  `played_country` sessions carry no timestamp to line up against a specific war's dates.
- **Map licensing (resolved, worth revisiting if Paradox's stance ever changes)**: the
  interactive Map tab's derived `map_data/location_ids.png`/`locations.json` ARE bundled into
  `dist/` and served publicly (see "Map" above) — a deliberate call, made without an explicit
  written Paradox rule covering this exact case, weighing their general fan-content terms
  (free, non-commercial) and the pdx.tools/Skanderbeg precedent. Paradox's own copyrighted
  source files (`locations.png`, `definitions.txt`, `named_locations/`) still never ship. If
  this call ever needs reversing, `scripts/build-netlify-site.js`'s `MAP_DATA_FILES` list is
  the one place gating what actually goes out.
- **Cross-device save sharing (mostly solved 2026-07-18)**: clicking "Share link" now uploads
  both the parsed save (`ShareStore.upload`, Supabase Storage) and, if a campaign ledger is
  currently loaded, the ledger itself (`ShareStore.uploadCampaignLedger` → the
  `eu5_upsert_campaign`/`_snapshots`/`_events` RPCs) — a recipient who's never run the recorder
  themselves now gets the real Llama Score, not just the save's own numbers. See
  `js/app.js`'s `tryRemoteCampaignLedger`/`uploadCurrentLlamaLedger` and
  `supabase/migrations/20260718*`. **Not yet carried over: `hidden-players.json`.** That file
  (written by the desktop Dashboard's Hide button, read by
  `LedgerConnect.readHiddenPlayers`) only ever gets read from a *local* recorder folder — the
  Supabase ledger tables/RPCs have no column for it at all, so a player manually marked
  departed on one machine won't show as hidden for anyone viewing a shared link on another.
  Untested as of this writing (the auto-remove/departed-player detection this would combine
  with hadn't been exercised yet either) — worth fixing alongside whenever that gets tested for
  real, by adding a `hidden_players` jsonb column to `eu5_campaigns` (or a sibling table) and
  wiring it through both the upload and fetch RPCs the same way `snapshots`/`events` already
  are.
