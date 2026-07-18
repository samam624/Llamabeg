# Llamabeg

A browser-based analyzer for Europa Universalis V save files — players, countries, world
stats, and multiplayer war scoring — in the spirit of [pdx.tools](https://pdx.tools) and
[Skanderbeg](https://www.skanderbeg.pm/) (neither of which support EU5). Everything runs
client-side: no build step to view it, and parsing happens entirely in your browser — a
save you open never leaves it. The one exception is opt-in: on a configured deploy, an
explicit **Share link** uploads a compressed copy of that one save so you can hand a
viewable link to someone who doesn't have the file (see "Sharing a save" below). Nothing
is uploaded automatically, ever.

Comes with two companion pieces for tracking a multiplayer campaign's wars over time (EU5
purges a concluded war from the save faster than most autosave intervals, so a single save
file can't always see it):

- **Llama Score Dashboard** — a Windows desktop app that watches your save folder while you
  play and builds a running campaign ledger. See [llama-dashboard/README.md](llama-dashboard/README.md).
- **Llama Score Logging Machine** — the same recorder as a standalone Node/CLI script, for
  non-Windows or headless use. See [llama-score-automatic-logging-machine/README.md](llama-score-automatic-logging-machine/README.md).

Point this web app at either one's output folder and it auto-scores every war it recorded —
see the **Llama Score** tab in the app itself for the full write-up of how scoring works
(the formula, how a winner is decided, and what makes a war's result "clean" vs. a fallback
White Peace).

## Features

- Drop in a `.eu5` save — compressed (straight from the game's save folder) or melted
  (plaintext) — and get an overview of countries, players, and world stats.
- **Map** with toggleable mapmodes (political, players, development, population, trade
  goods, religion, culture), pan/zoom, and hover detail.
- **Metrics** tables for every country and player (economy, military, demographics,
  estates), sortable and filterable.
- **Graphs** of population and tax base over time.
- **Black Death** tracker — real per-country death tolls, not a population-diff guess.
- **Llama Score / Alpaca Score** — multiplayer war scoring, PvP and PvE modes, backed by
  the campaign-ledger recorder above.

## Running locally

Workers loaded via `importScripts` are unreliable under `file://`, so serve the directory
instead of double-clicking `index.html`:

```
python -m http.server 8000
# or: npx serve
```

Then open `http://localhost:8000`.

### Map setup (optional, one-time)

The map needs two files derived from your own EU5 install — without this step,
everything else still works, the Map tab just shows an error instead of rendering.

1. Copy from your own EU5 install (`Europa Universalis V/game/in_game/map_data/`) into a
   new `map_data/` folder at the repo root:
   - `locations.png`
   - `definitions.txt`
   - `named_locations/00_default.txt`
2. From the repo root, run the two data-prep scripts:
   ```
   node tools/build-location-data.js      # -> map_data/locations.json
   python tools/bake-location-id-map.py   # -> map_data/location_ids.png
   ```

The three files copied in step 1 are Paradox's own copyrighted game files and stay
local-only (gitignored, never committed or deployed — see `map_data/README.md`). The two
generated in step 2 are a derived, data-only transform (a location-ID-to-pixel lookup image
and a name/color table — not a copy of Paradox's artwork) and *are* shipped with the
deployed site; see "License / data note" below.

### Sharing a save (optional backend)

Every view is addressable by a `?save=<playthrough-uuid>_<game-date>&tab=<tab>` URL. Out
of the box that link only resolves in a browser that already has the save (your own, or a
previous visit that cached it). Wire up the optional backend and **Copy link** becomes
**Share link**: it uploads a gzip-compressed copy of the *parsed* save (~5–6 MB, vs a
~60 MB raw `.eu5`, and the recipient just decompresses it — no re-parsing) to a public
[Supabase Storage](https://supabase.com/docs/guides/storage) bucket keyed by that same id,
so anyone you send the link to sees the actual save.

To enable it:

1. Create the bucket + read/write policies (one-time): `supabase db push` applies
   `supabase/migrations/*_shared_saves_bucket.sql`.
2. Provide the **public** project URL + anon key. On Netlify, set `SUPABASE_URL` /
   `SUPABASE_ANON_KEY` as build env vars (the build generates `config.js`). Locally, add
   the same two to `.env.local` and run `node scripts/write-config.js`. Both values are
   public-safe; the `service_role` key must never go here. See `config.example.js`.

The random campaign UUID in the key makes links unguessable (the bucket is public-read but
its listing isn't exposed). Nothing uploads automatically — only an explicit Share click.

## Tests

```
node test/run.js <melted-save-path>            # text parser, prints a summary
node test/run-binary.js <compressed-save-path> <melted-save-path>   # full cross-check
```

`run-binary.js` needs both a compressed and melted (plaintext) copy of the *same* save to
diff every extracted field against each other — this is the main correctness check for the
binary format parser, since EU5's save format isn't documented anywhere. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full technical write-up: how the save
formats were reverse-engineered, how the map's pixel data maps to in-game locations, how war
scoring's winner-detection actually works internally, and the validation results behind all
of it.

## Deploying (Netlify)

```
npm run build   # -> dist/ (index.html + css/ + js/ + assets/)
```

`netlify.toml` points Netlify at this same build command and serves `dist/`. The build only
copies `map_data/location_ids.png` and `map_data/locations.json` (if present locally) into
`dist/` — never the original `locations.png`/`definitions.txt`/`named_locations/` — see
"License / data note" below.

## License / data note

This repo contains no Paradox game assets. `map_data/locations.png`, `definitions.txt`, and
`named_locations/` (Paradox's own copyrighted files) are excluded from version control and
never deployed — see "Map setup" above and `map_data/README.md`. The deployed site does ship
two files *derived* from them (`location_ids.png`, a non-artistic ID-lookup image, and
`locations.json`, a name/color table) — this is an unofficial fan tool, not affiliated with
or endorsed by Paradox Interactive, and stays free with no paywall, consistent with Paradox's
fan-content terms.
