// Renders the province map with toggleable mapmodes. Loads two local assets
// (not from the save, not bundled/committed - see map_data/README.md):
//   map_data/location_ids.png - 16384x8192, R+G channels = location ID
//     (id = r | (g << 8)), a derived data-only transform of the game's
//     locations.png (see tools/bake-location-id-map.py) - never the raw
//     copyrighted artwork.
//   map_data/locations.json   - id -> { name, color } from definitions.txt
//     ordering + named_locations/00_default.txt (tools/build-location-data.js).
(function (root) {
  "use strict";

  const MAP_W = 16384;
  const MAP_H = 8192;
  const OUTSIDE_MAP_COLOR = [21, 16, 12]; // matches .map-canvas-wrap's CSS letterbox background
  const MAX_RENDER_DPR = 1.5;
  const LOCATION_BOUNDARY_MIN_SCALE = 0.33;
  const PLAYER_LABEL_FONT = "'Cinzel', 'Trajan Pro', 'Times New Roman', Georgia, serif";
  const WIKI_FILE_BASE = "https://eu5.paradoxwikis.com/Special:Redirect/file/";
  const wikiIcon = (name) => WIKI_FILE_BASE + encodeURIComponent(name);
  const MAP_MODE_ICONS = {
    political: wikiIcon("Select country.png"),
    players: wikiIcon("Players.png"),
    development: wikiIcon("Tab production.png"),
    population: wikiIcon("Tab demography.png"),
    tax: wikiIcon("Tax base.png"),
    trade: wikiIcon("Goods.png"),
    religion: wikiIcon("Religion.png"),
    culture: wikiIcon("Culture.png"),
    control: wikiIcon("Estates.png"),
    prosperity: wikiIcon("Tab advances.png"),
    marketAccess: wikiIcon("Market.png"),
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function fmtNum(n, digits) {
    if (n === undefined || n === null || Number.isNaN(n)) return "&mdash;";
    return Number(n).toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function fmtMaybeId(value, prefix) {
    if (value === undefined || value === null || value === "") return "&mdash;";
    return escapeHtml(prefix ? `${prefix} #${value}` : String(value));
  }

  function fmtPlainName(value) {
    if (value === undefined || value === null || value === "") return "";
    return String(value).replace(/_/g, " ");
  }

  function titleCaseName(value) {
    if (value === undefined || value === null || value === "") return "";
    return fmtPlainName(value)
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b[\p{L}\p{N}][\p{L}\p{N}'-]*/gu, (word) => {
        if (/^[A-Z0-9]{2,}$/.test(word)) return word;
        return word.charAt(0).toUpperCase() + word.slice(1);
      });
  }

  function fmtPercent(value, digits) {
    if (value === undefined || value === null || Number.isNaN(value)) return "&mdash;";
    return fmtNum(Number(value) * 100, digits) + "%";
  }

  function fmtPopulation(raw) {
    if (raw === undefined || raw === null || Number.isNaN(raw)) return "&mdash;";
    return Math.round(Number(raw) * 1000).toLocaleString() + " people";
  }

  function fmtCompactPopulation(raw) {
    if (raw === undefined || raw === null || Number.isNaN(raw)) return "&mdash;";
    const value = Number(raw);
    if (Math.abs(value) >= 1000) return fmtNum(value / 1000, value >= 10000 ? 1 : 2) + "M";
    return fmtNum(value, value >= 100 ? 1 : 2) + "k";
  }

  function humanize(value) {
    if (value === undefined || value === null || value === "") return "&mdash;";
    return escapeHtml(titleCaseName(value));
  }

  function sortedEntries(obj) {
    return Object.entries(obj || {}).sort((a, b) => {
      if (typeof a[1] === "number" && typeof b[1] === "number" && b[1] !== a[1]) return b[1] - a[1];
      return String(a[0]).localeCompare(String(b[0]));
    });
  }

  function detailStat(label, value) {
    return `<div class="location-detail-stat"><span>${escapeHtml(label)}</span><strong>${value}</strong></div>`;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("failed to load " + src));
      img.src = src;
    });
  }

  // Bump whenever map_data/ is regenerated (tools/build-location-data.js /
  // bake-location-id-map.py) and redeployed - these are now shipped,
  // immutable-cached assets (netlify.toml's /map_data/* rule), so a stale
  // browser copy needs a changed query string to know to re-fetch, the same
  // convention index.html's <script src>/<link> tags already use.
  const MAP_DATA_VERSION = "v1.0.0";

  // location_ids.png/locations.json are the same static, save-independent
  // asset every time (they don't depend on `result` at all) - decoding them
  // is expensive (idGrid alone is a 128M-entry Uint32Array, built via a
  // 16384x8192 getImageData() call, i.e. ~1GB of transient allocations for
  // the source image data + the array). createMapView() used to re-pay that
  // cost on every single save load/Map-tab visit, so the more saves you'd
  // loaded in one session the more of that garbage was sitting in the heap
  // awaiting GC - which is what was making pan/zoom drop frames over time.
  // Memoize both behind module-level promises so they're built once per page
  // load and reused for every save after that.
  let idGridPromise = null;
  function loadLocationIdGrid() {
    if (!idGridPromise) {
      idGridPromise = (async () => {
        const img = await loadImage(`map_data/location_ids.png?v=${MAP_DATA_VERSION}`);
        const canvas = document.createElement("canvas");
        canvas.width = MAP_W;
        canvas.height = MAP_H;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, MAP_W, MAP_H).data;
        // One id per pixel, computed once and reused for every mapmode repaint.
        const ids = new Uint32Array(MAP_W * MAP_H);
        for (let p = 0, i = 0; p < ids.length; p++, i += 4) {
          ids[p] = data[i] | (data[i + 1] << 8);
        }
        // `image` is kept alongside `ids` (not just discarded once decoded) so
        // the WebGL renderer can upload the same RG-encoded id map as a GPU
        // texture directly - it doesn't need the JS-side Uint32Array at all,
        // that's still only for hit-testing (clicks/hover/labels).
        return { ids, image: img };
      })().catch((err) => {
        idGridPromise = null; // let a transient load failure be retried on the next save
        throw err;
      });
    }
    return idGridPromise;
  }

  let locationNamesPromise = null;
  function loadLocationNames() {
    // Was `{ cache: "no-store" }` (no versioning at all) - changed to the
    // same query-string convention as MAP_DATA_VERSION above once this file
    // became a real shipped/immutable-cached production asset (previously
    // local-dev-only, where re-fetching on every load didn't matter). Bump
    // MAP_DATA_VERSION whenever this file's content actually changes, or a
    // stale cached copy will silently reproduce "fixed" bugs with zero
    // indication why - confirmed this happened once already under the old
    // no-cache-busting-at-all setup (see git history).
    if (!locationNamesPromise) {
      locationNamesPromise = fetch(`map_data/locations.json?v=${MAP_DATA_VERSION}`)
        .then((res) => res.json())
        .catch((err) => {
          locationNamesPromise = null;
          throw err;
        });
    }
    return locationNamesPromise;
  }

  // Deterministic but visually spread-out color for an arbitrary integer id
  // (used for mapmodes over IDs we don't have real names/colors for yet,
  // e.g. culture/religion - see README roadmap on name lookup tables).
  function colorForId(id) {
    const hue = (id * 137.508) % 360; // golden-angle spacing
    return hslToRgb(hue, 55, 50);
  }

  function hslToRgb(h, s, l) {
    s /= 100;
    l /= 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r, g, b;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }

  function parseRgbString(s) {
    const m = s && s.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    return m ? [+m[1], +m[2], +m[3]] : null;
  }

  // Simple string hash -> deterministic color, for mapmodes keyed by a
  // string rather than a numeric id (e.g. trade goods).
  function colorForString(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return colorForId(h);
  }

  function mixColor(a, b, amount) {
    return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * amount));
  }

  // A "hidden" player (the Players table's Hide button, or - per user
  // request - an automatic future hook from the desktop tracker detecting
  // someone left the campaign) should disappear from the map too: no player-
  // realm border/label, no "Players" mapmode grouping, no player name shown
  // in a country's tooltip/detail panel - not just fade from the Players
  // table. Every one of those map.js call sites reads a country's raw
  // `players` name array directly, so this one filter is the single place
  // that hides a name from all of them, given the same excludedPlayers Set
  // app.js already keeps in localStorage for the table. A country that
  // still has at least one OTHER, non-hidden player keeps reading as a
  // normal player country - only wholly-hidden countries drop out.
  function visiblePlayers(players, excludedPlayers) {
    if (!players || !players.length || !excludedPlayers || !excludedPlayers.size) return players || [];
    return players.filter((name) => !excludedPlayers.has(name));
  }

  // Trade goods need lots of distinct categorical hues, but the raw hashed
  // colors are too saturated for the rest of the Llamabeg map treatment.
  // Keep the hue identity, then pull it toward warm muted land and darken it
  // slightly so the mode reads as data-rich instead of neon. The final
  // darken step was originally -0.16, but that ended up reading too dark/
  // muddy once the neon problem was fixed - eased back up to -0.06 per
  // user feedback (still darkened from the raw hash color, just not as much).
  function tradeGoodDisplayColor(rawMaterial) {
    const rgb = colorForString(rawMaterial);
    return shadeColor(mixColor(rgb, NO_DATA_COLOR, 0.34), -0.06);
  }

  // Shifts a color toward white (amount > 0) or black (amount < 0), used to
  // give a vassal a shade of its overlord's color rather than an unrelated
  // one, so subject relationships read visually as a "family" of colors -
  // and also to darken a country's own color for its player-border outline.
  function shadeColor(rgb, amount) {
    return rgb.map((c) => Math.max(0, Math.min(255, Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount)))));
  }

  // Deterministic per-country shade offset so multiple vassals of the same
  // overlord are still visually distinct from each other, not just from
  // their overlord.
  function shadeAmountForId(id) {
    const OFFSETS = [-0.32, 0.3, -0.16, 0.2, -0.24, 0.12];
    return OFFSETS[id % OFFSETS.length];
  }

  // Numeric mapmodes (development, population, control, prosperity) all
  // share ONE heat palette: a single smooth gradient (dark brown -> near-
  // black -> yellow -> green -> bright cyan-blue), but with its control
  // points spaced UNEVENLY across percentile-rank space to match a specific
  // requested distribution - the bottom 30% of locations sit in the brown/
  // black range, the next 25% (30-55th percentile) transition through
  // yellow, the next 40% (55-95th) through green, and only the top 5%
  // reach blue. A hard-edged CLASSED version (flat color bands, no blend)
  // was tried first per an earlier request - confirmed on a real save it
  // made the percentile cutoffs unambiguous, but per user follow-up it's
  // smoothly blended between those same anchor points now instead: two
  // locations near the same percentile still read as distinct shades again
  // (the classed version made a 60th and 90th percentile location render
  // identically), while the top 5% still visibly pops to blue since that
  // control point is only a narrow 5%-wide span away from green.
  // HEAT_STOPS is a list of {t, color} breakpoints (t in percentile-rank
  // space, 0-1, NOT evenly spaced) - heatColor() linearly interpolates
  // between consecutive entries. The floor is a dark chocolate-brown, not
  // literal black: literal black ((28,21,14)-ish) is nearly identical to
  // this page's own --bg and to NON_PLAYER_MUTED, so a genuine 0% location
  // would be indistinguishable from "nothing rendered here."
  // Re-tuned per a reference screenshot the user matched against: brown/
  // black compressed into the bottom ~25%, green stretched wide (~45% of
  // the range), and blue pulled back to only the top 1% (a true "this is
  // an elite handful of locations" flag) - the ~14 points of range that
  // freed up when blue shrank from ~15% down to 1% went to yellow (now
  // ~29%, up from ~15%), not green, per user request. Brown and green's
  // spans are otherwise unchanged from the previous tuning.
  const HEAT_STOPS = [
    { t: 0.0, color: [60, 38, 20] }, // near-black floor
    { t: 0.25, color: [115, 72, 34] }, // bottom 25%: brown
    { t: 0.54, color: [225, 195, 60] }, // next 29%: yellow
    { t: 0.99, color: [120, 200, 90] }, // next 45%: green
    { t: 1.0, color: [90, 225, 235] }, // top 1%: bright cyan-blue
  ];
  function heatColor(t) {
    t = Math.max(0, Math.min(1, t));
    for (let i = 0; i < HEAT_STOPS.length - 1; i++) {
      const a = HEAT_STOPS[i];
      const b = HEAT_STOPS[i + 1];
      if (t < a.t || t > b.t) continue;
      const span = b.t - a.t;
      const u = span > 0 ? (t - a.t) / span : 0;
      return [0, 1, 2].map((i) => Math.round(a.color[i] + (b.color[i] - a.color[i]) * u));
    }
    return HEAT_STOPS[HEAT_STOPS.length - 1].color;
  }

  const NO_DATA_COLOR = [107, 96, 74]; // unclaimed/no-data land - distinct from water so it still reads as land
  const WATER_COLOR = [26, 48, 78];
  const NON_PLAYER_MUTED = [58, 54, 46]; // "Players" mapmode: everyone else fades into the background
  const BORDER_DARKEN = -0.62; // player-realm outline: this much darker than the location's own political color

  // `mapState` is a small mutable object (not rebuilt per-repaint) so a
  // checkbox like "shade vassals by overlord color" can be toggled without
  // reconstructing all the mode closures - see createMapView. Returns both
  // the mapmode table and `politicalColor` on its own, since the player-
  // realm border needs a location's political color regardless of which
  // mapmode is currently on screen (it's an overlay, not a mode).
  function buildMapModes(result, locationsMeta, mapState) {
    const locByNumber = new Map((result.locations || []).map((l) => [l.number, l]));
    const countryByNumber = result.countriesByNumber || new Map((result.countries || []).map((c) => [c.number, c]));
    const subjectToOverlord = new Map((result.dependencies || []).map((d) => [d.subject, d.overlord]));
    const cultureByNumber = new Map((result.cultures || []).map((c) => [c.number, c]));
    const religionByNumber = new Map((result.religions || []).map((r) => [r.number, r]));
    const marketByNumber = new Map((result.markets || []).map((m) => [m.number, m]));

    function isFocusedLoc(loc) {
      return !mapState.focusCountry || (loc && loc.owner === mapState.focusCountry);
    }

    // Heat gradients used to always run 0 -> max, but development/
    // population/tax/control/prosperity essentially never have any locations
    // actually near 0 in a real save (the lowest real Population might be
    // a few hundred, not 0) - stretching the full color range across
    // "0 to max" when nothing ever gets close to 0 wastes most of that
    // range: every real location bunches up in a thin slice near the
    // bright end, and the dark end of the gradient never gets used at all.
    // Scaling min -> max instead (per user request) uses the FULL color
    // range for the actual spread of values that exist, so real
    // differences between locations are visible rather than compressed.
    const HEAT_SCALE_FIELDS = ["development", "population", "tax", "control", "prosperity"];
    // development/population/tax get colored by PERCENTILE RANK among this
    // scope's locations, not by where the value sits between min and max
    // (even in log space) - see the note above filteredHeatColor for why:
    // real save data stays right-skewed even after a log transform, so a
    // continuous scale still crowds most locations toward one end. Needs a
    // sorted list of every real value in scope to look up a rank from.
    const PERCENTILE_FIELDS = new Set(["development", "population", "tax"]);
    function computeMetricScales(countryNumber) {
      const scales = {};
      for (const field of HEAT_SCALE_FIELDS) scales[field] = { min: Infinity, max: -Infinity, sorted: PERCENTILE_FIELDS.has(field) ? [] : null };
      let tradeGoodMax = 1;
      for (const l of result.locations || []) {
        if (countryNumber && l.owner !== countryNumber) continue;
        for (const field of HEAT_SCALE_FIELDS) {
          const v = ownedNumericOrZero(l, field);
          if (typeof v !== "number") continue;
          const scale = scales[field];
          if (v < scale.min) scale.min = v;
          if (v > scale.max) scale.max = v;
          if (scale.sorted) scale.sorted.push(v);
        }
        if (mapState.focusTradeGood && l.rawMaterial === mapState.focusTradeGood && typeof l.maxRawMaterialWorkers === "number" && l.maxRawMaterialWorkers > tradeGoodMax) {
          tradeGoodMax = l.maxRawMaterialWorkers;
        }
      }
      for (const field of HEAT_SCALE_FIELDS) {
        const scale = scales[field];
        if (scale.sorted) scale.sorted.sort((a, b) => a - b);
        // No real data at all (e.g. a country with zero locations focused),
        // or every value identical (min===max, would divide by zero) - fall
        // back to a plain 0-1 scale rather than producing NaN colors.
        if (!Number.isFinite(scale.min) || !Number.isFinite(scale.max) || scale.max <= scale.min) {
          scales[field] = { min: 0, max: Number.isFinite(scale.max) ? Math.max(scale.max, 1) : 1, sorted: scale.sorted };
        }
      }
      scales.tradeGood = tradeGoodMax;
      return scales;
    }

    // Rank of `value` within `sorted` (ascending), as a 0-1 fraction - the
    // fraction of same-scope locations at or below this one. Unlike any
    // value-based scale (linear or log), this is invariant to how skewed the
    // underlying distribution is: it only cares about order, so the colors
    // always spread evenly across the full gradient no matter how lopsided
    // real population/tax/development numbers get.
    function percentileRank(sorted, value) {
      if (!sorted || sorted.length <= 1) return 0.5;
      let lo = 0;
      let hi = sorted.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] < value) lo = mid + 1;
        else hi = mid;
      }
      // Average the rank of value's first and last occurrence so a run of
      // ties (common with e.g. tax=0) all land on the same, central color
      // instead of spreading across whatever range they happen to occupy.
      let hiIdx = lo;
      while (hiIdx < sorted.length && sorted[hiIdx] === value) hiIdx++;
      return (lo + hiIdx - 1) / 2 / (sorted.length - 1);
    }

    mapState.metricScales = computeMetricScales(mapState.focusCountry);

    function updateMetricScale(countryNumber) {
      mapState.metricScales = computeMetricScales(countryNumber);
    }

    // Impassable mountains/wasteland and non-ownable desert corridors
    // (map_data's default.map `impassable_mountains`/`non_ownable` lists,
    // baked into locations.json's `impassable` flag by
    // tools/build-location-data.js) are real terrain but never get a
    // meaningful development/control/prosperity value from the game -
    // ~1,971 of 28,573 locations. Confirmed these were dominating the
    // min/max heat scale: they render inside a country's own border (EU5
    // assigns administrative ownership over them regardless of them being
    // unusable), so ownedNumericOrZero's "owned but missing = 0" treatment
    // was counting a mountain range as a genuine 0%-control PROVINCE,
    // dragging that country's own scale floor down and compressing the
    // gradient's usable range for its real, meaningful locations.
    function isImpassable(loc) {
      const meta = loc && locationsMeta[loc.number];
      return !!(meta && meta.impassable);
    }

    // A location can be owned by a real country yet have no tracked value
    // at all for a given numeric field - confirmed on real data: ~2,100 of
    // 13,500 owned locations have no `control` value at all (presumably
    // freshly taken/contested land the game hasn't assigned a % to yet).
    // That's structurally different from a genuinely unowned/wilderness
    // location, which has NO data for anything and should keep reading as
    // neutral "no data" - only the owned-but-missing case gets treated as
    // an explicit 0 (the gradient's dark floor) instead of falling back to
    // the "no data" color, which is what was actually causing large owned
    // stretches of the map to look flatly uncolored instead of dark.
    //
    // Impassable-flagged terrain is excluded from the heat gradient
    // entirely, unconditionally - even on the ~166 of 1,971 impassable
    // locations that happen to carry a real, directly-parsed development/
    // control value. Tried letting those real values through (per-location
    // accuracy), but per user feedback that still let mountain terrain's
    // atypical values pull on the min/max SCALE, distorting the gradient's
    // range for the country's actual real land - excluding them outright
    // is what makes the rest of the country's own spread of values read
    // correctly. A handful of impassable locations losing their own real
    // color is the accepted tradeoff for that.
    // A location with a real owner can STILL be a total blank slate - no
    // population, no development, no control, nothing - even when it isn't
    // impassable-flagged. Root-caused on real data: applyProvinceOwnerFallback
    // (js/map.js) assigns a location's owner from its enclosing PROVINCE
    // whenever the location's own owner field is blank, specifically so
    // political-map coloring reads correctly for the ~10% of locations with
    // that gap - but that fallback owner doesn't mean the location has any
    // location-level data of its own. Confirmed: a real Serbia-owned
    // location (owner assigned only via the province fallback) had no
    // population/development/control/estate-tax/institutions at all, and
    // ownedNumericOrZero was reading its missing population as an explicit
    // 0 - reproducing the exact "fake 0%" problem the impassable-terrain
    // fix addressed, just via a different path. A location only gets the
    // "missing field -> 0" treatment now if it has at least ONE other real,
    // directly-parsed heat-scale field - genuine partial data (e.g. missing
    // just `control`) still gets the 0 fill; a location with NOTHING
    // tracked at all reads as neutral "no data" regardless of why it
    // appears owned.
    function hasAnyLocationData(loc) {
      return HEAT_SCALE_FIELDS.some((f) => typeof loc[f] === "number");
    }

    function ownedNumericOrZero(loc, field) {
      if (!loc || isImpassable(loc)) return undefined;
      if (typeof loc[field] === "number") return loc[field];
      if (!hasAnyLocationData(loc)) return undefined;
      return typeof loc.owner === "number" ? 0 : undefined;
    }

    // Development/population/tax are all heavily right-skewed (a handful of
    // capitals/cities dwarf ordinary locations) - skewed enough that even a
    // log scale still crowds most locations toward one end instead of
    // spreading them across the gradient (confirmed against a PDX Tools
    // screenshot of the same save/region: our log-scaled version still read
    // mostly orange/brown where theirs was a real green-to-brown spread).
    // PERCENTILE_FIELDS (see computeMetricScales) get colored by rank instead
    // - see percentileRank(). Control/prosperity are roughly-bounded
    // percentages (prosperity can even go negative), not skewed the same
    // way, so they stay a plain linear min->max scale. Legends still show
    // real units either way (scale.min/max are never transformed).
    function filteredHeatColor(loc, field) {
      const value = ownedNumericOrZero(loc, field);
      if (typeof value !== "number") return NO_DATA_COLOR;
      if (!isFocusedLoc(loc)) return NON_PLAYER_MUTED;
      const scale = (mapState.metricScales && mapState.metricScales[field]) || { min: 0, max: 1 };
      if (PERCENTILE_FIELDS.has(field)) {
        return heatColor(percentileRank(scale.sorted, value));
      }
      return heatColor((value - scale.min) / (scale.max - scale.min));
    }

    function countryColor(countryNumber) {
      const country = countryByNumber.get(countryNumber);
      const rgb = country && parseRgbString(country.color);
      return rgb || colorForId(countryNumber);
    }

    function definitionColor(def, fallbackId) {
      const rgb = def && parseRgbString(def.color);
      return rgb || colorForId(fallbackId);
    }

    function definitionName(def, fallbackPrefix, id) {
      const raw = def && (def.name || def.key || def.definition);
      return raw ? titleCaseName(raw) : `${fallbackPrefix} #${id}`;
    }

    function marketName(marketId) {
      const market = marketByNumber.get(marketId);
      const center = market && locationsMeta[market.center];
      if (center && center.name) return `${titleCaseName(center.name)} Market`;
      return marketId === undefined || marketId === null ? null : `Market #${marketId}`;
    }

    // Markets carry their own `color` in the save (same rgb the game's own
    // UI uses for that market) - reuse it directly rather than hashing a
    // new one, per the user's "color coded like in the game" ask. Falls
    // back to a hashed color only for the rare case a market has none.
    function marketColor(marketId) {
      const market = marketByNumber.get(marketId);
      const rgb = market && parseRgbString(market.color);
      return rgb || colorForId(marketId);
    }

    // "Market Access" used to run every location through ONE shared
    // gradient regardless of which market it belongs to, so two locations
    // in different markets with the same access % looked identical - no way
    // to tell which market's reach you were even looking at. Now each
    // market gets its OWN localized gradient: grey/dark (low access) rising
    // to that specific market's own real color (high access), so color
    // simultaneously encodes "which market" (hue) and "how much access."
    //
    // A 75%-inflection "peaks then darkens again" curve was tried and
    // reverted per user feedback - it made the map look uniformly washed
    // out (most real locations sit in a broad 30-70% band, which under that
    // curve never reached anywhere near full color). Back to a plain
    // monotonic rise from dark to the market's color, but weighted (t ^
    // DARKEN_POWER, not a straight 1:1 blend) so it falls into the dark/
    // grey floor faster as access drops - only genuinely high-access
    // locations show real color, everything else reads as clearly muted
    // instead of a wishy-washy 50/50 blend in the middle of the range.
    const MARKET_ACCESS_LOW_COLOR = HEAT_STOPS[0].color;
    const MARKET_ACCESS_DARKEN_POWER = 2.4;
    // Neutral stand-in hue for the legend bar, which has to illustrate the
    // dark -> color SHAPE generically since the real color varies per
    // market on the actual map.
    const MARKET_ACCESS_LEGEND_COLOR = [91, 157, 217];
    function accessCurveColor(base, t) {
      t = Math.max(0, Math.min(1, t));
      const u = Math.pow(t, MARKET_ACCESS_DARKEN_POWER);
      return [0, 1, 2].map((i) => Math.round(MARKET_ACCESS_LOW_COLOR[i] + (base[i] - MARKET_ACCESS_LOW_COLOR[i]) * u));
    }
    function marketAccessColor(marketId, t) {
      return accessCurveColor(marketColor(marketId), t);
    }

    function politicalColor(ownerNumber) {
      if (mapState.vassalShading && subjectToOverlord.has(ownerNumber)) {
        const overlord = subjectToOverlord.get(ownerNumber);
        return shadeColor(countryColor(overlord), shadeAmountForId(ownerNumber));
      }
      return countryColor(ownerNumber);
    }

    function isPlayerCountry(countryNumber) {
      const country = countryByNumber.get(countryNumber);
      return !!(country && visiblePlayers(country.players, mapState.excludedPlayers).length > 0);
    }

    function modePlayerRealmRoot(countryNumber) {
      let current = countryNumber;
      for (let hops = 0; hops < 8 && current != null; hops++) {
        if (isPlayerCountry(current)) return current;
        current = subjectToOverlord.get(current);
      }
      return 0;
    }

    // Groups all locations by keyFn(loc), counts them, and returns the
    // biggest `cap` groups by location count (the most visually prominent
    // colors on the map) plus how many groups got left out - for
    // high-cardinality mapmodes (political has hundreds of countries; a
    // legend can't list them all, so it shows what's actually prominent
    // instead, per the "fold into Other" guidance for overflowing
    // categorical legends).
    function categoricalLegend(keyFn, colorFn, labelFn, cap) {
      const counts = new Map();
      for (const loc of result.locations || []) {
        const key = keyFn(loc);
        if (key == null) continue;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const items = sorted.slice(0, cap).map(([key]) => ({ label: labelFn(key), color: colorFn(key) }));
      return { type: "categorical", items, overflow: Math.max(0, sorted.length - items.length) };
    }

    function gradientLegend(minValue, maxValue, formatFn) {
      return { type: "gradient", colorAt: heatColor, minLabel: formatFn(minValue), maxLabel: formatFn(maxValue) };
    }

    function scaleFor(field) {
      return (mapState.metricScales && mapState.metricScales[field]) || { min: 0, max: 1 };
    }

    // Sea/lake locations are part of the same numbering as land (see
    // README); locationsMeta.type comes from default.map via
    // tools/build-location-data.js.
    const modes = {
      political: {
        label: "Political",
        colorFor(id) {
          const loc = locByNumber.get(id);
          if (!loc || !loc.owner) return NO_DATA_COLOR;
          return politicalColor(loc.owner);
        },
        tooltipFor(id) {
          const loc = locByNumber.get(id);
          if (!loc) return null;
          const country = countryByNumber.get(loc.owner);
          if (!country) return "Unowned";
          const overlord = subjectToOverlord.has(loc.owner) ? countryByNumber.get(subjectToOverlord.get(loc.owner)) : null;
          return overlord ? `${country.tag} (${overlord.tag} subject)` : country.tag;
        },
        // No legend - Political has 1000+ distinct owners in a real save,
        // so a "top 12 + 1040 more" categorical legend was never actually
        // useful (removed per user request); the political border/outline
        // and hover tooltip already identify a location's owner directly.
      },
      players: {
        label: "Players",
        colorFor(id) {
          const loc = locByNumber.get(id);
          if (!loc || !loc.owner) return NO_DATA_COLOR;
          const root = modePlayerRealmRoot(loc.owner);
          if (!root) return NON_PLAYER_MUTED;
          return loc.owner === root ? countryColor(root) : shadeColor(countryColor(root), shadeAmountForId(loc.owner));
        },
        tooltipFor(id) {
          const loc = locByNumber.get(id);
          const country = loc && countryByNumber.get(loc.owner);
          if (!country) return null;
          const root = modePlayerRealmRoot(loc.owner);
          const rootCountry = root && countryByNumber.get(root);
          if (!rootCountry) return `${country.tag} (AI)`;
          return loc.owner === root ? `${country.tag} - ${visiblePlayers(rootCountry.players, mapState.excludedPlayers).map(titleCaseName).join(", ")}` : `${country.tag} (${rootCountry.tag} Subject)`;
        },
        legend: () =>
          categoricalLegend(
            (loc) => modePlayerRealmRoot(loc.owner) || null,
            (owner) => countryColor(owner),
            (owner) => {
              const c = countryByNumber.get(owner);
              return `${c.tag} - ${visiblePlayers(c.players, mapState.excludedPlayers).map(titleCaseName).join(", ")}`;
            },
            20
          ),
      },
      development: {
        label: "Development",
        colorFor(id) {
          return filteredHeatColor(locByNumber.get(id), "development");
        },
        tooltipFor(id) {
          const loc = locByNumber.get(id);
          const value = ownedNumericOrZero(loc, "development");
          return typeof value === "number" ? `Development: ${value.toFixed(1)}` : null;
        },
        legend: () => {
          const s = scaleFor("development");
          return gradientLegend(s.min, s.max, (v) => v.toFixed(0) + " pts");
        },
      },
      population: {
        label: "Population",
        colorFor(id) {
          return filteredHeatColor(locByNumber.get(id), "population");
        },
        tooltipFor(id) {
          const loc = locByNumber.get(id);
          const value = ownedNumericOrZero(loc, "population");
          return typeof value === "number" ? `Population: ${fmtPopulation(value)}` : null;
        },
        legend: () => {
          const s = scaleFor("population");
          return gradientLegend(s.min, s.max, (v) => fmtPopulation(v));
        },
      },
      tax: {
        label: "Tax Base",
        colorFor(id) {
          return filteredHeatColor(locByNumber.get(id), "tax");
        },
        tooltipFor(id) {
          const loc = locByNumber.get(id);
          const value = ownedNumericOrZero(loc, "tax");
          return typeof value === "number" ? `Tax Base: ${fmtNum(value, 3)} tax` : null;
        },
        legend: () => {
          const s = scaleFor("tax");
          return gradientLegend(s.min, s.max, (v) => fmtNum(v, 2) + " tax");
        },
      },
      control: {
        label: "Control",
        colorFor(id) {
          return filteredHeatColor(locByNumber.get(id), "control");
        },
        tooltipFor(id) {
          const loc = locByNumber.get(id);
          const value = ownedNumericOrZero(loc, "control");
          return typeof value === "number" ? `Control: ${fmtPercent(value, 1)}` : null;
        },
        legend: () => {
          const s = scaleFor("control");
          return gradientLegend(s.min, s.max, (v) => fmtPercent(v, 0));
        },
      },
      prosperity: {
        label: "Prosperity",
        colorFor(id) {
          return filteredHeatColor(locByNumber.get(id), "prosperity");
        },
        tooltipFor(id) {
          const loc = locByNumber.get(id);
          const value = ownedNumericOrZero(loc, "prosperity");
          return typeof value === "number" ? `Prosperity: ${fmtPercent(value, 1)}` : null;
        },
        legend: () => {
          const s = scaleFor("prosperity");
          return gradientLegend(s.min, s.max, (v) => fmtPercent(v, 0));
        },
      },
      marketAccess: {
        label: "Markets",
        colorFor(id) {
          const loc = locByNumber.get(id);
          if (!loc || typeof loc.marketAccess !== "number") return NO_DATA_COLOR;
          if (!isFocusedLoc(loc)) return NON_PLAYER_MUTED;
          // No market id on record for this location (rare) - fall back to
          // the old single global gradient rather than showing flat grey.
          if (loc.market === undefined || loc.market === null) return heatColor(loc.marketAccess);
          return marketAccessColor(loc.market, loc.marketAccess);
        },
        tooltipFor(id) {
          const loc = locByNumber.get(id);
          const market = loc && marketName(loc.market);
          return loc && typeof loc.marketAccess === "number" ? `Market Access: ${fmtPercent(loc.marketAccess, 1)}${market ? ` (${market})` : ""}` : null;
        },
        // A per-market swatch list doesn't actually explain what the COLOR
        // means (that's what hovering a location's tooltip is for) - the
        // legend's job here is just the dark -> color shape, shown once in
        // a neutral stand-in color rather than listing 100+ markets' real
        // hues.
        legend: () => ({
          type: "gradient",
          colorAt: (t) => accessCurveColor(MARKET_ACCESS_LEGEND_COLOR, t),
          minLabel: "0%",
          maxLabel: "100%",
          note: "Hue varies by market - hover a location for its exact % and market name.",
        }),
      },
      trade: {
        label: "Trade Goods",
        colorFor(id) {
          const loc = locByNumber.get(id);
          if (!loc || !loc.rawMaterial) return NO_DATA_COLOR;
          if (mapState.focusTradeGood && loc.rawMaterial !== mapState.focusTradeGood) return NON_PLAYER_MUTED;
          return tradeGoodDisplayColor(loc.rawMaterial);
        },
        tooltipFor(id) {
          const loc = locByNumber.get(id);
          if (!loc || !loc.rawMaterial) return null;
          const name = titleCaseName(loc.rawMaterial);
          return typeof loc.maxRawMaterialWorkers === "number" ? `${name}: ${fmtNum(loc.maxRawMaterialWorkers, 0)} RGO capacity` : name;
        },
        // No legend - removed per user request (this and Culture/Religion/
        // Political have too many distinct categories for a legend to be
        // useful); the hover tooltip already identifies a location's good.
      },
      religion: {
        label: "Religion",
        colorFor(id) {
          const loc = locByNumber.get(id);
          if (!loc || !loc.religion) return NO_DATA_COLOR;
          return definitionColor(religionByNumber.get(loc.religion), loc.religion);
        },
        tooltipFor(id) {
          const loc = locByNumber.get(id);
          return loc && loc.religion ? definitionName(religionByNumber.get(loc.religion), "Religion", loc.religion) : null;
        },
        // No legend - see the Trade Goods mode's comment above.
      },
      culture: {
        label: "Culture",
        colorFor(id) {
          const loc = locByNumber.get(id);
          if (!loc || !loc.culture) return NO_DATA_COLOR;
          return definitionColor(cultureByNumber.get(loc.culture), loc.culture);
        },
        tooltipFor(id) {
          const loc = locByNumber.get(id);
          return loc && loc.culture ? definitionName(cultureByNumber.get(loc.culture), "Culture", loc.culture) : null;
        },
        // No legend - see the Trade Goods mode's comment above.
      },
    };

    return { modes, politicalColor, marketName, updateMetricScale };
  }

  // "Contain" fit: the largest scale (screen CSS px per source px) at which
  // the whole MAP_W x MAP_H source fits inside a wrapCssW x wrapCssH box,
  // centered (letterboxed on whichever axis doesn't exactly fill).
  function computeFit(wrapCssW, wrapCssH) {
    const w = Math.max(1, wrapCssW);
    const h = Math.max(1, wrapCssH);
    const scale = Math.min(w / MAP_W, h / MAP_H);
    return { scale, offX: (w - MAP_W * scale) / 2, offY: (h - MAP_H * scale) / 2 };
  }

  // Keeps a source-space offset from panning the map fully out of view: if
  // the scaled map is smaller than the viewport on an axis it's centered
  // (can't pan on that axis), otherwise it's clamped so the map always
  // covers the full viewport on that axis.
  function clampAxis(off, scale, mapDim, wrapDim) {
    const scaledDim = mapDim * scale;
    if (scaledDim <= wrapDim) return (wrapDim - scaledDim) / 2;
    return Math.max(wrapDim - scaledDim, Math.min(0, off));
  }

  function computeNeutralEnclosedRealms(idGrid, maxId, isWater, isNeutralLand, playerRealmLUT) {
    const parent = new Int32Array(maxId + 1);
    for (let id = 0; id <= maxId; id++) parent[id] = isNeutralLand[id] ? id : 0;

    function find(id) {
      let root = id;
      while (parent[root] !== root) root = parent[root];
      while (parent[id] !== id) {
        const next = parent[id];
        parent[id] = root;
        id = next;
      }
      return root;
    }

    function union(a, b) {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    }

    function forEachDifferentEdge(fn) {
      for (let y = 0; y < MAP_H; y++) {
        const row = y * MAP_W;
        const hasDown = y + 1 < MAP_H;
        for (let x = 0; x < MAP_W; x++) {
          const id = idGrid[row + x];
          if (x + 1 < MAP_W) {
            const right = idGrid[row + x + 1];
            if (id !== right) fn(id, right);
          }
          if (hasDown) {
            const down = idGrid[row + x + MAP_W];
            if (id !== down) fn(id, down);
          }
        }
      }
    }

    forEachDifferentEdge((a, b) => {
      if (isNeutralLand[a] && isNeutralLand[b]) union(a, b);
    });

    const componentRealm = new Uint32Array(maxId + 1);
    const componentConflict = new Uint8Array(maxId + 1);
    function addBorder(neutralId, otherId) {
      if (!isNeutralLand[neutralId] || isNeutralLand[otherId] || isWater[otherId]) return;
      const root = find(neutralId);
      const realm = playerRealmLUT[otherId];
      if (!realm) {
        componentConflict[root] = 1;
        return;
      }
      if (componentRealm[root] && componentRealm[root] !== realm) componentConflict[root] = 1;
      else componentRealm[root] = realm;
    }

    forEachDifferentEdge((a, b) => {
      addBorder(a, b);
      addBorder(b, a);
    });

    const enclosed = new Uint32Array(maxId + 1);
    for (let id = 0; id <= maxId; id++) {
      if (!isNeutralLand[id]) continue;
      const root = find(id);
      if (componentRealm[root] && !componentConflict[root]) enclosed[id] = componentRealm[root];
    }
    return enclosed;
  }

  // ===== WebGL renderer =====
  // renderViewport() below does real work: fill color, box-average
  // downsampling once zoomed out, border/coastline detection, selection
  // highlight - all recomputed from scratch, in JS, for every destination
  // pixel, on every single animation frame while panning/zooming. That's a
  // few million pixel-ops, several passes deep, on ONE thread, every ~16ms -
  // measured as a genuine, sustained CPU load (confirmed via profiling: this
  // is what was showing up as ~30% CPU + fan spin-up on pan/zoom, worse the
  // further zoomed out since the box-average pass samples a 3x3
  // neighborhood per pixel). A GPU is built for exactly this shape of
  // workload - the same handful of operations applied independently to
  // millions of pixels in parallel - which is presumably how PDX Tools stays
  // smooth at any zoom level. This renderer ports the same per-pixel logic
  // into a WebGL2 fragment shader; createMapView() falls back to the CPU
  // renderViewport() below if WebGL2 isn't available at all.
  const LUT_TEX_W = 256;

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error("Map shader compile error: " + info);
    }
    return shader;
  }

  function createGLProgram(gl, vsSource, fsSource) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error("Map shader link error: " + info);
    }
    return program;
  }

  const MAP_VERTEX_SHADER_SRC = `#version 300 es
    in vec2 a_pos;
    out vec2 v_destPixel;
    uniform vec2 u_destSize;
    void main() {
      // a_pos is a fullscreen quad in clip space. Flip Y here so v_destPixel
      // matches the rest of this file's (0,0)-top-left, y-increases-downward
      // convention (WebGL clip space has y increasing upward) instead of
      // needing every downstream calculation to remember the flip.
      v_destPixel = vec2((a_pos.x * 0.5 + 0.5) * u_destSize.x, (1.0 - (a_pos.y * 0.5 + 0.5)) * u_destSize.y);
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  // Mirrors renderViewport()'s per-pixel logic: point-sample (or, once
  // zoomed out past ~1.5 source px per dest px, 3x3-box-average) the id
  // texture per destination pixel, look up that id's fill/border color in
  // small LUT textures, and darken/blacken pixels that sit on a location,
  // realm, or coastline edge - all evaluated independently per fragment, in
  // parallel, instead of a sequential JS loop.
  const MAP_FRAGMENT_SHADER_SRC = `#version 300 es
    precision highp float;
    precision highp int;

    in vec2 v_destPixel;
    out vec4 outColor;

    uniform sampler2D u_idTex;
    uniform sampler2D u_fillTex;    // rgb = fill color, a = isWater
    uniform sampler2D u_borderTex;  // rgb = political-darkened border color, a = isSea
    uniform sampler2D u_ownerTex;   // rg = ownerLUT (16-bit), ba = playerRealmLUT (16-bit)
    uniform sampler2D u_neutralTex; // rg = neutralEnclosedRealmLUT (16-bit), b = isLake

    uniform vec2 u_mapSize;
    uniform vec2 u_lutSize;
    uniform float u_scale;   // view.scale * dpr
    uniform vec2 u_offset;   // view.offX/offY * dpr
    uniform float u_box;     // 1.0 or 3.0
    uniform bool u_drawLocationBorders; // thin per-location outline - only past a min zoom, or it's just noise once zoomed out far enough that many locations share a screen pixel
    uniform bool u_drawRealmBorders;    // player-realm border + coastline shading - always true now (see createMapView's render()); parameterized only so the shader keeps working if a caller ever needs to disable it
    uniform float u_dilateRadius; // thickens the realm border to a visible line - a raw 1px edge is indistinguishable from the ordinary location-boundary line next to it
    uniform float u_selectedId;   // -1 if nothing selected
    uniform vec3 u_outsideColor;
    uniform vec3 u_selectFill;
    uniform vec3 u_selectEdge;

    vec2 lutUV(float id) {
      float x = mod(id, u_lutSize.x);
      float y = floor(id / u_lutSize.x);
      return (vec2(x, y) + 0.5) / u_lutSize;
    }

    bool inMap(vec2 srcPixel) {
      return srcPixel.x >= 0.0 && srcPixel.y >= 0.0 && srcPixel.x < u_mapSize.x && srcPixel.y < u_mapSize.y;
    }

    float idAt(vec2 srcPixel) {
      vec2 uv = (srcPixel + 0.5) / u_mapSize;
      vec4 texel = texture(u_idTex, uv);
      return floor(texel.r * 255.0 + 0.5) + floor(texel.g * 255.0 + 0.5) * 256.0;
    }

    vec2 srcPixelFor(vec2 destPixel) {
      return floor((destPixel - u_offset) / u_scale);
    }

    // -1.0 means "off the edge of the map" (never counts as a border side);
    // 0.0 means "not a player realm" (still a real value - a border between
    // 0 and a nonzero realm is exactly a player/AI border).
    float realmAt(vec2 destPixel) {
      vec2 sp = srcPixelFor(destPixel);
      if (!inMap(sp)) return -1.0;
      vec4 ownerTexel = texture(u_ownerTex, lutUV(idAt(sp)));
      return floor(ownerTexel.b * 255.0 + 0.5) + floor(ownerTexel.a * 255.0 + 0.5) * 256.0;
    }

    void main() {
      vec2 srcPixel = srcPixelFor(v_destPixel);
      if (!inMap(srcPixel)) {
        outColor = vec4(u_outsideColor / 255.0, 1.0);
        return;
      }

      float id = idAt(srcPixel);
      vec4 fillHere = texture(u_fillTex, lutUV(id));
      float isWaterHere = fillHere.a > 0.5 ? 1.0 : 0.0;
      vec3 color = fillHere.rgb * 255.0;

      if (u_box > 1.5) {
        vec3 sum = vec3(0.0);
        float n = 0.0;
        for (float by = -1.0; by <= 1.0; by += 1.0) {
          for (float bx = -1.0; bx <= 1.0; bx += 1.0) {
            vec2 sp = srcPixel + vec2(bx, by);
            if (!inMap(sp)) continue;
            sum += texture(u_fillTex, lutUV(idAt(sp))).rgb * 255.0;
            n += 1.0;
          }
        }
        if (n > 0.0) color = sum / n;
      }

      vec2 rightSrc = srcPixelFor(v_destPixel + vec2(1.0, 0.0));
      vec2 downSrc = srcPixelFor(v_destPixel + vec2(0.0, 1.0));
      bool hasRight = inMap(rightSrc);
      bool hasDown = inMap(downSrc);
      float idRight = hasRight ? idAt(rightSrc) : id;
      float idDown = hasDown ? idAt(downSrc) : id;

      if (u_drawLocationBorders || u_drawRealmBorders) {
        vec4 fillRight = texture(u_fillTex, lutUV(idRight));
        vec4 fillDown = texture(u_fillTex, lutUV(idDown));

        if (u_drawLocationBorders) {
          bool rightLocBorder = hasRight && idRight != id && (isWaterHere < 0.5 || fillRight.a <= 0.5);
          bool downLocBorder = hasDown && idDown != id && (isWaterHere < 0.5 || fillDown.a <= 0.5);
          if (rightLocBorder || downLocBorder) color = vec3(0.0);
        }

      if (u_drawRealmBorders) {
        vec4 ownerHereTexel = texture(u_ownerTex, lutUV(id));
        vec4 ownerRightTexel = texture(u_ownerTex, lutUV(idRight));
        vec4 ownerDownTexel = texture(u_ownerTex, lutUV(idDown));
        float realmHere = floor(ownerHereTexel.b * 255.0 + 0.5) + floor(ownerHereTexel.a * 255.0 + 0.5) * 256.0;
        float realmRight = floor(ownerRightTexel.b * 255.0 + 0.5) + floor(ownerRightTexel.a * 255.0 + 0.5) * 256.0;
        float realmDown = floor(ownerDownTexel.b * 255.0 + 0.5) + floor(ownerDownTexel.a * 255.0 + 0.5) * 256.0;

        vec4 borderRightTexel = texture(u_borderTex, lutUV(idRight));
        vec4 borderDownTexel = texture(u_borderTex, lutUV(idDown));
        float seaHere = texture(u_borderTex, lutUV(id)).a > 0.5 ? 1.0 : 0.0;
        float rightWater = hasRight ? (fillRight.a > 0.5 ? 1.0 : 0.0) : isWaterHere;
        float downWater = hasDown ? (fillDown.a > 0.5 ? 1.0 : 0.0) : isWaterHere;
        float rightSea = hasRight ? (borderRightTexel.a > 0.5 ? 1.0 : 0.0) : 0.0;
        float downSea = hasDown ? (borderDownTexel.a > 0.5 ? 1.0 : 0.0) : 0.0;

        vec4 neutralHereTexel = texture(u_neutralTex, lutUV(id));
        vec4 neutralRightTexel = texture(u_neutralTex, lutUV(idRight));
        vec4 neutralDownTexel = texture(u_neutralTex, lutUV(idDown));
        float neutralHere = floor(neutralHereTexel.r * 255.0 + 0.5) + floor(neutralHereTexel.g * 255.0 + 0.5) * 256.0;
        float neutralRight = floor(neutralRightTexel.r * 255.0 + 0.5) + floor(neutralRightTexel.g * 255.0 + 0.5) * 256.0;
        float neutralDown = floor(neutralDownTexel.r * 255.0 + 0.5) + floor(neutralDownTexel.g * 255.0 + 0.5) * 256.0;
        float lakeRight = hasRight ? (neutralRightTexel.b > 0.5 ? 1.0 : 0.0) : 0.0;
        float lakeDown = hasDown ? (neutralDownTexel.b > 0.5 ? 1.0 : 0.0) : 0.0;

        bool rightSuppressed = hasRight && ((neutralRight != 0.0 && neutralRight == realmHere) || (neutralHere != 0.0 && neutralHere == realmRight));
        bool downSuppressed = hasDown && ((neutralDown != 0.0 && neutralDown == realmHere) || (neutralHere != 0.0 && neutralHere == realmDown));

        bool rightRealmBorder = hasRight && lakeRight < 0.5 && isWaterHere < 0.5 && rightWater < 0.5 && realmHere != realmRight && !rightSuppressed;
        bool downRealmBorder = hasDown && lakeDown < 0.5 && isWaterHere < 0.5 && downWater < 0.5 && realmHere != realmDown && !downSuppressed;

        bool rightCoastHere = hasRight && rightSea > 0.5 && realmHere != 0.0 && isWaterHere < 0.5;
        bool rightCoastNeighbor = hasRight && seaHere > 0.5 && realmRight != 0.0 && rightWater < 0.5;
        bool downCoastHere = hasDown && downSea > 0.5 && realmHere != 0.0 && isWaterHere < 0.5;
        bool downCoastNeighbor = hasDown && seaHere > 0.5 && realmDown != 0.0 && downWater < 0.5;
        bool rightCoastOutline = rightCoastHere || rightCoastNeighbor;
        bool downCoastOutline = downCoastHere || downCoastNeighbor;

        bool nearRealmBorder = rightRealmBorder || rightCoastOutline || downRealmBorder || downCoastOutline;
        // A raw 1px-wide edge is indistinguishable from the ordinary black
        // location-boundary line that's already drawn everywhere - CPU dilates
        // this same edge into a several-px-thick line so player/AI realm
        // borders actually read as a distinct feature. Cheap here since it
        // only runs on the (much smaller) viewport, not the full 134M-pixel
        // source, and only when settled (u_drawRealmBorders is false while
        // dragging).
        if (!nearRealmBorder && u_dilateRadius > 1.5) {
          float r = min(u_dilateRadius, 6.0);
          for (float dy = -6.0; dy <= 6.0 && !nearRealmBorder; dy += 1.0) {
            if (abs(dy) > r) continue;
            for (float dx = -6.0; dx <= 6.0 && !nearRealmBorder; dx += 1.0) {
              if (abs(dx) > r || (dx == 0.0 && dy == 0.0)) continue;
              float otherRealm = realmAt(v_destPixel + vec2(dx, dy));
              if (otherRealm >= 0.0 && otherRealm != realmHere && (otherRealm > 0.0 || realmHere > 0.0)) {
                nearRealmBorder = true;
              }
            }
          }
        }

        if (nearRealmBorder) {
          color = texture(u_borderTex, lutUV(id)).rgb * 255.0;
        } else if ((hasRight && isWaterHere != rightWater) || (hasDown && isWaterHere != downWater)) {
          color *= 0.6;
        }
      }
      }

      if (u_selectedId >= 0.0 && id == u_selectedId) {
        color = color * 0.45 + u_selectFill * 0.55;
        bool edge = !hasRight || idRight != id || !hasDown || idDown != id ||
          !inMap(srcPixelFor(v_destPixel + vec2(-1.0, 0.0))) || idAt(srcPixelFor(v_destPixel + vec2(-1.0, 0.0))) != id ||
          !inMap(srcPixelFor(v_destPixel + vec2(0.0, -1.0))) || idAt(srcPixelFor(v_destPixel + vec2(0.0, -1.0))) != id;
        if (edge) color = u_selectEdge;
      }

      outColor = vec4(color / 255.0, 1.0);
    }
  `;

  // Builds the small per-id lookup textures the fragment shader above reads:
  // one row of RGBA8 texels per id, wide enough (LUT_TEX_W) that even a
  // large id set stays a modest few-hundred-KB texture. Static fields
  // (owner/realm/water/sea/lake) are packed once per session; fill/border
  // colors get repacked whenever buildLUTs() reruns (mode switch, vassal
  // toggle, trade-good focus).
  function packStaticLutTextures(maxId, staticLuts) {
    const w = LUT_TEX_W;
    const h = Math.max(1, Math.ceil((maxId + 1) / w));
    const owner = new Uint8Array(w * h * 4);
    const neutral = new Uint8Array(w * h * 4);
    for (let id = 0; id <= maxId; id++) {
      const o = id * 4;
      const ownerId = staticLuts.ownerLUT[id] || 0;
      const realmId = staticLuts.playerRealmLUT[id] || 0;
      owner[o] = ownerId & 0xff;
      owner[o + 1] = (ownerId >> 8) & 0xff;
      owner[o + 2] = realmId & 0xff;
      owner[o + 3] = (realmId >> 8) & 0xff;
      const neutralId = staticLuts.neutralEnclosedRealmLUT[id] || 0;
      neutral[o] = neutralId & 0xff;
      neutral[o + 1] = (neutralId >> 8) & 0xff;
      neutral[o + 2] = staticLuts.isLake[id] ? 255 : 0;
    }
    return { w, h, owner, neutral };
  }

  function packModeLutTextures(maxId, w, h, luts, isWater, isSea) {
    const fill = new Uint8Array(w * h * 4);
    const border = new Uint8Array(w * h * 4);
    for (let id = 0; id <= maxId; id++) {
      const o = id * 4;
      fill[o] = luts.lutR[id];
      fill[o + 1] = luts.lutG[id];
      fill[o + 2] = luts.lutB[id];
      fill[o + 3] = isWater[id] ? 255 : 0;
      border[o] = luts.borderR[id];
      border[o + 1] = luts.borderG[id];
      border[o + 2] = luts.borderB[id];
      border[o + 3] = isSea[id] ? 255 : 0;
    }
    return { fill, border };
  }

  // Tries to stand up a WebGL2 renderer for the given canvas; returns null
  // (caller falls back to the CPU renderViewport()) if WebGL2 isn't
  // available at all, which should only happen on very old hardware/drivers.
  function createGLMapRenderer(canvas, idImage, maxId, initialLuts) {
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
    if (!gl) return null;

    let program;
    try {
      program = createGLProgram(gl, MAP_VERTEX_SHADER_SRC, MAP_FRAGMENT_SHADER_SRC);
    } catch (err) {
      console.error(err);
      return null;
    }
    gl.useProgram(program);

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(program, "a_pos");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const u = {};
    for (const name of [
      "u_destSize",
      "u_mapSize",
      "u_lutSize",
      "u_scale",
      "u_offset",
      "u_box",
      "u_drawLocationBorders",
      "u_drawRealmBorders",
      "u_dilateRadius",
      "u_selectedId",
      "u_outsideColor",
      "u_selectFill",
      "u_selectEdge",
      "u_idTex",
      "u_fillTex",
      "u_borderTex",
      "u_ownerTex",
      "u_neutralTex",
    ]) {
      u[name] = gl.getUniformLocation(program, name);
    }

    function makeTexture(unit) {
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return tex;
    }

    const idTex = makeTexture(0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, idImage);

    const fillTex = makeTexture(1);
    const borderTex = makeTexture(2);
    const ownerTex = makeTexture(3);
    const neutralTex = makeTexture(4);

    const staticLuts = packStaticLutTextures(maxId, initialLuts);
    const lutW = staticLuts.w;
    const lutH = staticLuts.h;
    gl.activeTexture(gl.TEXTURE0 + 3);
    gl.bindTexture(gl.TEXTURE_2D, ownerTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, lutW, lutH, 0, gl.RGBA, gl.UNSIGNED_BYTE, staticLuts.owner);
    gl.activeTexture(gl.TEXTURE0 + 4);
    gl.bindTexture(gl.TEXTURE_2D, neutralTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, lutW, lutH, 0, gl.RGBA, gl.UNSIGNED_BYTE, staticLuts.neutral);

    function setModeLuts(luts) {
      const { fill, border } = packModeLutTextures(maxId, lutW, lutH, luts, initialLuts.isWater, initialLuts.isSea);
      gl.activeTexture(gl.TEXTURE0 + 1);
      gl.bindTexture(gl.TEXTURE_2D, fillTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, lutW, lutH, 0, gl.RGBA, gl.UNSIGNED_BYTE, fill);
      gl.activeTexture(gl.TEXTURE0 + 2);
      gl.bindTexture(gl.TEXTURE_2D, borderTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, lutW, lutH, 0, gl.RGBA, gl.UNSIGNED_BYTE, border);
    }

    function render(destW, destH, view, dpr, box, drawLocationBorders, drawRealmBorders, selectedId) {
      if (canvas.width !== destW) canvas.width = destW;
      if (canvas.height !== destH) canvas.height = destH;
      gl.viewport(0, 0, destW, destH);
      gl.useProgram(program);

      gl.uniform2f(u.u_destSize, destW, destH);
      gl.uniform2f(u.u_mapSize, MAP_W, MAP_H);
      gl.uniform2f(u.u_lutSize, lutW, lutH);
      gl.uniform1f(u.u_scale, view.scale * dpr);
      gl.uniform2f(u.u_offset, view.offX * dpr, view.offY * dpr);
      gl.uniform1f(u.u_box, box);
      gl.uniform1i(u.u_drawLocationBorders, drawLocationBorders ? 1 : 0);
      gl.uniform1i(u.u_drawRealmBorders, drawRealmBorders ? 1 : 0);
      // Mirrors renderViewport()'s CPU dilation radius formula exactly, so
      // the border reads the same thickness either way.
      gl.uniform1f(u.u_dilateRadius, Math.max(1, Math.round((1.5 + (box > 1 ? box - 1 : 0)) * dpr)));
      gl.uniform1f(u.u_selectedId, typeof selectedId === "number" && selectedId > 0 ? selectedId : -1);
      gl.uniform3f(u.u_outsideColor, OUTSIDE_MAP_COLOR[0], OUTSIDE_MAP_COLOR[1], OUTSIDE_MAP_COLOR[2]);
      gl.uniform3f(u.u_selectFill, 255, 245, 135);
      gl.uniform3f(u.u_selectEdge, 255, 255, 255);

      gl.uniform1i(u.u_idTex, 0);
      gl.uniform1i(u.u_fillTex, 1);
      gl.uniform1i(u.u_borderTex, 2);
      gl.uniform1i(u.u_ownerTex, 3);
      gl.uniform1i(u.u_neutralTex, 4);

      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    return { render, setModeLuts };
  }

  // Renders only the currently-visible source rectangle (per `view` and the
  // wrap's current CSS box) into a canvas sized to the viewport itself
  // (times devicePixelRatio) - not the old approach of always materializing
  // all 134M pixels of the full world and then CSS-transforming a giant
  // canvas for pan/zoom. Border/coastline detection is done by comparing
  // already-downsampled DESTINATION pixels, not by dilating a fixed-radius
  // mask at source resolution: a thin source-space line aliases away
  // unpredictably once heavily downsampled for a zoomed-out view, which is
  // what made the old border look "patchy". Comparing at output resolution
  // keeps the line a consistent ~2-3 screen px wide at any zoom level, and
  // it's cheap because destW*destH is a few million pixels, not 134M.
  //
  // This is now the WebGL renderer's fallback path (see createGLMapRenderer
  // above) - only used when WebGL2 isn't available at all.
  function renderViewport(ctx, canvas, wrapCssW, wrapCssH, dpr, view, idGrid, luts, selectedId) {
    const destW = Math.max(1, Math.round(wrapCssW * dpr));
    const destH = Math.max(1, Math.round(wrapCssH * dpr));
    if (canvas.width !== destW) canvas.width = destW;
    if (canvas.height !== destH) canvas.height = destH;

    const { lutR, lutG, lutB, borderR, borderG, borderB, isWater, isSea, isLake, ownerLUT, playerRealmLUT, neutralEnclosedRealmLUT, playerLabels, tradeGoodLabels } = luts;
    const s = view.scale * dpr;
    const ox = view.offX * dpr;
    const oy = view.offY * dpr;

    let cache = canvas._mapRenderCache;
    const cellCount = destW * destH;
    if (!cache || cache.destW !== destW || cache.destH !== destH) {
      cache = {
        destW,
        destH,
        imgData: ctx.createImageData(destW, destH),
        srcIdAt: new Uint32Array(cellCount),
        destRealm: new Uint32Array(cellCount),
        inMap: new Uint8Array(cellCount),
        boundary: new Uint8Array(cellCount),
        hDilated: new Uint8Array(cellCount),
      };
      canvas._mapRenderCache = cache;
    }
    const imgData = cache.imgData;
    const out = imgData.data;
    const srcIdAt = cache.srcIdAt;
    const destRealm = cache.destRealm;
    const inMap = cache.inMap;
    const boundary = cache.boundary;
    const hDilated = cache.hDilated;
    inMap.fill(0);
    boundary.fill(0);

    // When zoomed out far enough that one destination pixel covers several
    // source pixels, point-sampling a single one picks an almost-arbitrary
    // sample out of that neighborhood - fine over large contiguous regions,
    // but visibly noisy wherever the source packs a lot of detail into a
    // small area (e.g. the fragmented Arctic islands near the map's top
    // edge, which showed up as speckly vertical streaks). Averaging a small
    // small 3x3 box of source samples smooths that out; skipped when zoomed in close
    // (box === 1, the common interactive case) so panning stays cheap.
    const step = 1 / s;
    const box = step > 1.5 ? 3 : 1;
    const half = box >> 1;

    for (let dy = 0; dy < destH; dy++) {
      const srcY = Math.floor((dy - oy) / s);
      const rowBase = srcY * MAP_W;
      const destRow = dy * destW;
      for (let dx = 0; dx < destW; dx++) {
        const srcX = Math.floor((dx - ox) / s);
        const di = destRow + dx;
        const i = di * 4;
        if (srcX < 0 || srcY < 0 || srcX >= MAP_W || srcY >= MAP_H) {
          out[i] = OUTSIDE_MAP_COLOR[0];
          out[i + 1] = OUTSIDE_MAP_COLOR[1];
          out[i + 2] = OUTSIDE_MAP_COLOR[2];
          out[i + 3] = 255;
          continue;
        }

        const id = idGrid[rowBase + srcX];
        srcIdAt[di] = id;
        destRealm[di] = ownerLUT[id];
        inMap[di] = 1;
        if (box === 1) {
          out[i] = lutR[id];
          out[i + 1] = lutG[id];
          out[i + 2] = lutB[id];
        } else {
          let sumR = 0,
            sumG = 0,
            sumB = 0,
            n = 0;
          for (let by = -half; by <= half; by++) {
            const sy = srcY + by;
            if (sy < 0 || sy >= MAP_H) continue;
            const rb = sy * MAP_W;
            for (let bx = -half; bx <= half; bx++) {
              const sx = srcX + bx;
              if (sx < 0 || sx >= MAP_W) continue;
              const sid = idGrid[rb + sx];
              sumR += lutR[sid];
              sumG += lutG[sid];
              sumB += lutB[sid];
              n++;
            }
          }
          out[i] = n ? sumR / n : lutR[id];
          out[i + 1] = n ? sumG / n : lutG[id];
          out[i + 2] = n ? sumB / n : lutB[id];
        }
        out[i + 3] = 255;
      }
    }

    const COAST_SHADE = 0.6;
    const drawDetailedBorders = s >= LOCATION_BOUNDARY_MIN_SCALE;
    if (drawDetailedBorders) {
      for (let dy = 0; dy < destH; dy++) {
        const destRow = dy * destW;
        const hasDown = dy + 1 < destH;
        for (let dx = 0; dx < destW; dx++) {
          const di = destRow + dx;
          if (!inMap[di]) continue;
          const id = srcIdAt[di];
          const rightDiff = dx + 1 < destW && inMap[di + 1] && srcIdAt[di + 1] !== id && (!isWater[id] || !isWater[srcIdAt[di + 1]]);
          const downDiff = hasDown && inMap[di + destW] && srcIdAt[di + destW] !== id && (!isWater[id] || !isWater[srcIdAt[di + destW]]);
          if (rightDiff || downDiff) {
            const i = di * 4;
            out[i] = 0;
            out[i + 1] = 0;
            out[i + 2] = 0;
          }
        }
      }
    }

    if (s >= 0.08) {
      for (let dy = 0; dy < destH; dy++) {
        const destRow = dy * destW;
        const hasDown = dy + 1 < destH;
        for (let dx = 0; dx < destW; dx++) {
          const di = destRow + dx;
          if (!inMap[di]) continue;
          const id = srcIdAt[di];
          if (isWater[id]) continue;
          const ownerHere = ownerLUT[id];
          if (!ownerHere) continue;
          const hasRight = dx + 1 < destW && inMap[di + 1];
          const hasDownPixel = hasDown && inMap[di + destW];
          const rightId = hasRight ? srcIdAt[di + 1] : id;
          const downId = hasDownPixel ? srcIdAt[di + destW] : id;
          const rightOwner = hasRight && !isWater[rightId] ? ownerLUT[rightId] : ownerHere;
          const downOwner = hasDownPixel && !isWater[downId] ? ownerLUT[downId] : ownerHere;
          if (ownerHere !== rightOwner || ownerHere !== downOwner) {
            const i = di * 4;
            out[i] = Math.round(out[i] * 0.42);
            out[i + 1] = Math.round(out[i + 1] * 0.42);
            out[i + 2] = Math.round(out[i + 2] * 0.42);
          }
        }
      }
    }

    // 1px-precise (in dest space) player-realm boundary / coastline pass -
    // thickened into a solid line below via the same 2-pass box dilation as
    // before, just over the much smaller viewport buffer. Comparing realm
    // IDENTITY (the top player-controlled country of the overlord chain),
    // not just a boolean "is this player-owned" flag, matters here: two
    // *different* player realms sitting directly next to each other both
    // read "player-owned", so a boolean comparison never sees a difference
    // and no border was drawn between them - the bug behind "border between
    // players still not working".
    let hasPlayerBoundary = false;
    {
      for (let dy = 0; dy < destH; dy++) {
        const destRow = dy * destW;
        const hasDown = dy + 1 < destH;
        for (let dx = 0; dx < destW; dx++) {
          const di = destRow + dx;
          if (!inMap[di]) continue;
          const hasRight = dx + 1 < destW;
          const id = srcIdAt[di];
          const water = isWater[id];
          const ownedHere = playerRealmLUT[id];
          const rightInMap = hasRight && inMap[di + 1];
          const downInMap = hasDown && inMap[di + destW];
          const idRight = rightInMap ? srcIdAt[di + 1] : id;
          const idDown = downInMap ? srcIdAt[di + destW] : id;
          const rightSea = rightInMap ? isSea[idRight] : 0;
          const downSea = downInMap ? isSea[idDown] : 0;
          const rightLake = rightInMap ? isLake[idRight] : 0;
          const downLake = downInMap ? isLake[idDown] : 0;
          const rightWater = rightInMap ? isWater[idRight] : water;
          const downWater = downInMap ? isWater[idDown] : water;
          const ownedRight = rightInMap ? playerRealmLUT[idRight] : ownedHere;
          const ownedDown = downInMap ? playerRealmLUT[idDown] : ownedHere;
          // neutralEnclosedRealmLUT defaults to 0 for EVERY id that isn't an
          // actually-enclosed wasteland pocket (ordinary AI-owned land included) -
          // so comparing it against `ownedHere`/`ownedRight` without also requiring
          // a nonzero match spuriously fires whenever the *other* side's realm is
          // plain 0 (i.e. any real player/AI border), not just at genuine enclosed-
          // wasteland pockets. That silently suppressed nearly every player-vs-AI
          // border pixel map-wide (border only survived between two different
          // player realms, where both sides are nonzero). Requiring the enclosed-
          // realm value itself to be nonzero restricts suppression to real matches.
          const rightSuppressedNeutral =
            rightInMap &&
            ((neutralEnclosedRealmLUT[idRight] !== 0 && neutralEnclosedRealmLUT[idRight] === ownedHere) ||
              (neutralEnclosedRealmLUT[id] !== 0 && neutralEnclosedRealmLUT[id] === ownedRight));
          const downSuppressedNeutral =
            downInMap &&
            ((neutralEnclosedRealmLUT[idDown] !== 0 && neutralEnclosedRealmLUT[idDown] === ownedHere) ||
              (neutralEnclosedRealmLUT[id] !== 0 && neutralEnclosedRealmLUT[id] === ownedDown));
          // A land-realm border exists whenever this pixel and its right/down
          // neighbor belong to different realms and at least one side is
          // player-owned ("ownedHere !== ownedRight" already guarantees that -
          // two neutral (0) tiles can't differ). Previously this ALSO required
          // `ownedHere` (the left/top pixel of the pair) specifically to be
          // the player-owned side, which silently missed every transition
          // where the neutral tile came first in scan order (top/left) - over
          // a real diagonal/curved border that happens for roughly half its
          // length, in contiguous runs (not isolated single-pixel gaps
          // dilation could bridge), producing the "spotty" look. Now flags
          // the border regardless of which side is "here" vs "neighbor", and
          // marks BOTH pixels of the pair so a following pixel's own scan
          // doesn't need to independently rediscover the same edge.
          const rightRealmBorder = rightInMap && !rightLake && !water && !rightWater && ownedHere !== ownedRight && !rightSuppressedNeutral;
          const downRealmBorder = downInMap && !downLake && !water && !downWater && ownedHere !== ownedDown && !downSuppressedNeutral;
          // Coastlines need the same scan-order symmetry as realm borders.
          // The old test only handled land-current/sea-neighbor pairs, so
          // sea-current/land-neighbor edges were skipped and coastal player
          // outlines looked intermittently patchy.
          const rightCoastHere = rightInMap && rightSea && ownedHere && !water;
          const rightCoastNeighbor = rightInMap && isSea[id] && ownedRight && !rightWater;
          const downCoastHere = downInMap && downSea && ownedHere && !water;
          const downCoastNeighbor = downInMap && isSea[id] && ownedDown && !downWater;
          const rightCoastOutline = rightCoastHere || rightCoastNeighbor;
          const downCoastOutline = downCoastHere || downCoastNeighbor;
          if (rightRealmBorder || rightCoastOutline) {
            if (rightRealmBorder || rightCoastHere) boundary[di] = 1;
            if (rightRealmBorder || rightCoastNeighbor) boundary[di + 1] = 1;
            hasPlayerBoundary = true;
          }
          if (downRealmBorder || downCoastOutline) {
            if (downRealmBorder || downCoastHere) boundary[di] = 1;
            if (downRealmBorder || downCoastNeighbor) boundary[di + destW] = 1;
            hasPlayerBoundary = true;
          }
          if (!rightRealmBorder && !rightCoastOutline && !downRealmBorder && !downCoastOutline) {
            if ((rightInMap && water !== rightWater) || (downInMap && water !== downWater)) {
              const i = di * 4;
              out[i] *= COAST_SHADE;
              out[i + 1] *= COAST_SHADE;
              out[i + 2] *= COAST_SHADE;
            }
          }
        }
      }
    }

    if (hasPlayerBoundary) {
      hDilated.fill(0);
      // The raw per-pixel boundary pass above single-point-samples each
      // destination pixel (one Math.floor'd source coordinate), same as the
      // fill-color pass. That's fine 1:1 or zoomed in (box === 1), but once
      // zoomed out far enough that `box` kicks in (several source px per
      // dest px), a curved/diagonal border's single sample can alternate
      // in and out of "different owner" between adjacent dest pixels in a
      // non-monotonic way - raw `boundary` hits end up sparse/aliased
      // rather than a dense ~1px-thick line, and a small fixed dilation
      // radius isn't wide enough to bridge those gaps - the "spotty"
      // border reported at regional/zoomed-out views. Scale the dilation
      // radius up with `box` so it still reliably bridges the gaps.
      const T = Math.max(1, Math.round((1.5 + (box > 1 ? box - 1 : 0)) * dpr));
      for (let y = 0; y < destH; y++) {
        const rowStart = y * destW;
        let count = 0;
        for (let k = 0; k <= T && k < destW; k++) count += boundary[rowStart + k];
        for (let x = 0; x < destW; x++) {
          hDilated[rowStart + x] = count > 0 ? 1 : 0;
          const leaving = x - T;
          const entering = x + T + 1;
          if (leaving >= 0) count -= boundary[rowStart + leaving];
          if (entering < destW) count += boundary[rowStart + entering];
        }
      }
      for (let x = 0; x < destW; x++) {
        let count = 0;
        for (let k = 0; k <= T && k < destH; k++) count += hDilated[k * destW + x];
        for (let y = 0; y < destH; y++) {
          const di = y * destW + x;
          if (count > 0 && inMap[di] && !isWater[srcIdAt[di]]) {
            // Each side of a shared border draws its OWN location's darkened
            // political color (not a neighbor's, not uniform white) - so two
            // adjacent player nations show two visibly different dark tones
            // instead of one indistinguishable line.
            const id = srcIdAt[di];
            const i = di * 4;
            out[i] = borderR[id];
            out[i + 1] = borderG[id];
            out[i + 2] = borderB[id];
          }
          const leavingY = y - T;
          const enteringY = y + T + 1;
          if (leavingY >= 0) count -= hDilated[leavingY * destW + x];
          if (enteringY < destH) count += hDilated[enteringY * destW + x];
        }
      }
    }

    if (selectedId) {
      const SELECT_FILL = [255, 245, 135];
      const SELECT_EDGE = [255, 255, 255];
      for (let dy = 0; dy < destH; dy++) {
        const row = dy * destW;
        const hasDown = dy + 1 < destH;
        for (let dx = 0; dx < destW; dx++) {
          const di = row + dx;
          if (!inMap[di] || srcIdAt[di] !== selectedId) continue;
          const i = di * 4;
          out[i] = Math.round(out[i] * 0.45 + SELECT_FILL[0] * 0.55);
          out[i + 1] = Math.round(out[i + 1] * 0.45 + SELECT_FILL[1] * 0.55);
          out[i + 2] = Math.round(out[i + 2] * 0.45 + SELECT_FILL[2] * 0.55);
          const edge =
            dx === 0 ||
            !inMap[di - 1] ||
            srcIdAt[di - 1] !== selectedId ||
            dx + 1 >= destW ||
            !inMap[di + 1] ||
            srcIdAt[di + 1] !== selectedId ||
            dy === 0 ||
            !inMap[di - destW] ||
            srcIdAt[di - destW] !== selectedId ||
            !hasDown ||
            !inMap[di + destW] ||
            srcIdAt[di + destW] !== selectedId;
          if (edge) {
            out[i] = SELECT_EDGE[0];
            out[i + 1] = SELECT_EDGE[1];
            out[i + 2] = SELECT_EDGE[2];
          }
        }
      }
    }

    ctx.putImageData(imgData, 0, 0);
    drawLabelOverlay(ctx, destW, destH, dpr, s, ox, oy, playerLabels, tradeGoodLabels, view.scale);
  }

  // Shared between the CPU renderViewport() above (drawing straight onto
  // its own already-painted 2D canvas) and the WebGL renderer below (drawing
  // onto a separate transparent overlay canvas stacked on top of the GPU-
  // rendered one, since a canvas can only ever have one kind of rendering
  // context) - same label positions/styling either way. Callers are
  // responsible for clearing `targetCtx` first if it needs clearing (the
  // CPU path doesn't - putImageData just overwrote it).
  function drawLabelOverlay(targetCtx, destW, destH, dpr, s, ox, oy, playerLabels, tradeGoodLabels, viewScale) {
    if (playerLabels && playerLabels.length) {
      targetCtx.save();
      targetCtx.font = `600 ${Math.round(16 * dpr)}px ${PLAYER_LABEL_FONT}`;
      targetCtx.textAlign = "center";
      targetCtx.textBaseline = "middle";
      targetCtx.lineWidth = Math.max(4, 4 * dpr);
      targetCtx.strokeStyle = "rgba(8, 8, 8, 0.94)";
      targetCtx.fillStyle = "rgba(244, 232, 188, 0.98)";
      for (const label of playerLabels) {
        const x = label.x * s + ox;
        const y = label.y * s + oy;
        if (x < -80 || y < -20 || x > destW + 80 || y > destH + 20) continue;
        const text = label.text.toUpperCase();
        targetCtx.strokeText(text, x, y);
        targetCtx.fillText(text, x, y);
      }
      targetCtx.restore();
    }

    if (tradeGoodLabels && tradeGoodLabels.length && viewScale > 0.28) {
      targetCtx.save();
      targetCtx.font = `700 ${Math.round(11 * dpr)}px ${PLAYER_LABEL_FONT}`;
      targetCtx.textAlign = "center";
      targetCtx.textBaseline = "middle";
      targetCtx.lineWidth = Math.max(3, 3 * dpr);
      targetCtx.strokeStyle = "rgba(5, 7, 10, 0.88)";
      targetCtx.fillStyle = "rgba(255, 255, 255, 0.92)";
      for (const label of tradeGoodLabels) {
        const x = label.x * s + ox;
        const y = label.y * s + oy;
        if (x < -40 || y < -20 || x > destW + 40 || y > destH + 20) continue;
        targetCtx.strokeText(label.text, x, y);
        targetCtx.fillText(label.text, x, y);
      }
      targetCtx.restore();
    }
  }

  // A location's own `owner` field can be legitimately blank in the save
  // even when it's genuinely controlled - EU5 also tracks ownership one
  // level up, per-PROVINCE (several locations per province, matching
  // definitions.txt's "_province" grouping - see tools/build-location-
  // data.js's per-location `province` name and js/clausewitz.js's
  // provinces.database extraction). Confirmed against a real save: three
  // whole provinces (verona/venice/vicenza_province) were fully owned by
  // one player while EVERY individual location inside them had a blank
  // owner field - the in-game client and third-party tools read ownership
  // at the province level, so without this the map (and the location
  // detail panel) showed those locations as unowned when they weren't.
  // Mutates `result.locations` in place so every consumer (map fill/
  // borders, the location/country detail panels, tooltips) sees the
  // corrected owner uniformly, not just whichever one happens to check
  // last. Only fills in what's missing - never overrides a location that
  // already has its own explicit owner.
  function applyProvinceOwnerFallback(result, locationsMeta) {
    const provinceOwners = result.provinceOwnerByDefinition;
    if (!provinceOwners) return;
    for (const loc of result.locations || []) {
      if (loc.owner) continue;
      const meta = locationsMeta[loc.number];
      const province = meta && meta.province;
      if (!province) continue;
      const owner = provinceOwners[province];
      if (!owner) continue;
      loc.owner = owner;
      if (!loc.controller) loc.controller = owner;
    }
  }

  function computePlayerLabels(idGrid, countryByNumber, excludedPlayers) {
    // Straightforward: find each player country's capital location on the
    // map and put the label directly on it. Scans the full grid once (a
    // plain Map lookup per pixel) rather than sampling on a stride, so even
    // a tiny capital province is guaranteed to be found.
    const capitalIdToCountry = new Map();
    for (const country of countryByNumber.values()) {
      const players = visiblePlayers(country.players, excludedPlayers);
      if (players.length && country.capital) {
        capitalIdToCountry.set(country.capital, country.number);
      }
    }

    const points = new Map();
    for (let y = 0; y < MAP_H; y++) {
      const row = y * MAP_W;
      for (let x = 0; x < MAP_W; x++) {
        const countryNumber = capitalIdToCountry.get(idGrid[row + x]);
        if (countryNumber === undefined) continue;
        if (!points.has(countryNumber)) points.set(countryNumber, { x, y });
      }
    }

    const labels = [];
    for (const [countryNumber, { x, y }] of points.entries()) {
      const country = countryByNumber.get(countryNumber);
      labels.push({ x, y, text: visiblePlayers(country.players, excludedPlayers).map(titleCaseName).join(", ") });
    }
    return labels;
  }

  function computeTradeGoodLabels(idGrid, locByNumber, locationsMeta) {
    const targetIds = new Set();
    for (const loc of locByNumber.values()) {
      if (loc && loc.rawMaterial && typeof loc.maxRawMaterialWorkers === "number" && loc.maxRawMaterialWorkers > 0) {
        const meta = locationsMeta[loc.number];
        if (meta && meta.type !== "sea" && meta.type !== "lake") targetIds.add(loc.number);
      }
    }
    if (!targetIds.size) return [];

    const sampleStep = 18;
    const footprints = new Map();
    function touch(id, x, y) {
      let fp = footprints.get(id);
      if (!fp) {
        fp = { sumX: 0, sumY: 0, n: 0 };
        footprints.set(id, fp);
      }
      fp.sumX += x;
      fp.sumY += y;
      fp.n++;
    }

    for (let y = 0; y < MAP_H; y += sampleStep) {
      const row = y * MAP_W;
      for (let x = 0; x < MAP_W; x += sampleStep) {
        const id = idGrid[row + x];
        if (targetIds.has(id)) touch(id, x, y);
      }
    }

    const labels = [];
    for (const [id, fp] of footprints.entries()) {
      const loc = locByNumber.get(id);
      if (!loc || !fp.n) continue;
      labels.push({ x: fp.sumX / fp.n, y: fp.sumY / fp.n, material: loc.rawMaterial, text: fmtNum(loc.maxRawMaterialWorkers, 0) });
    }
    return labels;
  }

  // A fresh createMapView() call rebuilds the whole DOM subtree (a new save
  // was loaded, or the user switched back to the Map tab), but setupPanZoom
  // registers its drag listeners on `window` rather than the (replaced)
  // canvas/wrap - those aren't cleaned up on their own the way node-scoped
  // listeners are when their element is discarded, so without an explicit
  // teardown they'd pile up indefinitely (one dead pair of window listeners
  // plus one dead ResizeObserver per save loaded), each one still holding a
  // reference to the previous session's now-detached DOM. Tear down the
  // prior session before building the next one.
  let activeSession = null;

  async function createMapView(container, result, excludedPlayers) {
    if (activeSession) {
      activeSession.abortController.abort();
      activeSession.resizeObserver.disconnect();
      activeSession = null;
    }

    const { ids: idGrid, image: idImage } = await loadLocationIdGrid();
    const locationsMeta = await loadLocationNames();
    applyProvinceOwnerFallback(result, locationsMeta);

    container.innerHTML = "";
    const toolbar = document.createElement("div");
    toolbar.className = "map-toolbar";
    const mapBody = document.createElement("div");
    mapBody.className = "map-body";
    const canvasWrap = document.createElement("div");
    canvasWrap.className = "map-canvas-wrap";
    const canvas = document.createElement("canvas");
    // Text labels (player/trade-good names) are drawn on a separate 2D
    // canvas stacked on top of `canvas` via CSS, rather than onto `canvas`
    // itself - the WebGL renderer below owns `canvas` (a canvas element can
    // only ever have one kind of rendering context), so text still needs an
    // ordinary 2D context to land on. Transparent background + pointer-
    // events:none so it's purely a visual overlay; all mouse handling stays
    // on `canvas`/`canvasWrap` exactly as before.
    const labelCanvas = document.createElement("canvas");
    labelCanvas.className = "map-label-overlay";
    const tooltip = document.createElement("div");
    tooltip.className = "map-tooltip";
    tooltip.hidden = true;
    const countryDetails = document.createElement("div");
    countryDetails.className = "country-details";
    countryDetails.hidden = true;
    const details = document.createElement("div");
    details.className = "location-details";
    details.hidden = true;
    details.innerHTML = '<div class="location-detail-empty">Click a land location to inspect ownership, population, tax, buildings, and local metrics.</div>';
    const legendEl = document.createElement("div");
    legendEl.className = "map-legend";
    canvasWrap.appendChild(canvas);
    canvasWrap.appendChild(labelCanvas);
    canvasWrap.appendChild(tooltip);
    mapBody.appendChild(canvasWrap);
    mapBody.appendChild(toolbar);
    mapBody.appendChild(legendEl);
    mapBody.appendChild(countryDetails);
    mapBody.appendChild(details);
    container.appendChild(mapBody);

    // Try WebGL2 first - it must be the *first* getContext() call on this
    // canvas, since a canvas element commits to one context type for life.
    // `glRenderer` stays undefined until the first buildLUTs() result is
    // available (render() below falls back to the CPU path until then);
    // null means WebGL2 genuinely isn't available on this machine and the
    // CPU renderViewport() path (using `ctx`) is used for the whole session.
    let glRenderer;
    let ctx = null;
    const labelCtx = labelCanvas.getContext("2d");
    const mapState = { vassalShading: true, focusCountry: 0, focusTradeGood: null, excludedPlayers: excludedPlayers || new Set() };
    const { modes, politicalColor, marketName, updateMetricScale } = buildMapModes(result, locationsMeta, mapState);
    let currentMode = modes.political;
    let selectedLocationId = 0;
    let selectedCountryId = 0;
    const countryDetailSort = { demographicTax: { key: "pop", dir: -1 } };
    const locationDetailSort = { buildings: { key: "amount", dir: -1 } };
    let maxId = 0;
    for (let i = 0; i < idGrid.length; i++) if (idGrid[i] > maxId) maxId = idGrid[i];

    const countryByNumber = result.countriesByNumber || new Map((result.countries || []).map((c) => [c.number, c]));
    const locByNumber = new Map((result.locations || []).map((l) => [l.number, l]));
    const subjectToOverlord = new Map((result.dependencies || []).map((d) => [d.subject, d.overlord]));
    const cultureByNumber = new Map((result.cultures || []).map((c) => [c.number, c]));
    const religionByNumber = new Map((result.religions || []).map((r) => [r.number, r]));
    const playerLabels = computePlayerLabels(idGrid, countryByNumber, mapState.excludedPlayers);
    const tradeGoodLabels = computeTradeGoodLabels(idGrid, locByNumber, locationsMeta);

    function countryLabel(countryNumber) {
      const country = countryByNumber.get(countryNumber);
      if (!country) return countryNumber ? `#${countryNumber}` : null;
      const players = visiblePlayers(country.players, mapState.excludedPlayers);
      const playerText = players.length ? ` - ${players.map(titleCaseName).join(", ")}` : "";
      return `${country.tag || "?"} (#${country.number})${playerText}`;
    }

    function updateMapBodyClasses() {
      mapBody.classList.toggle("has-country", !countryDetails.hidden);
      mapBody.classList.toggle("has-location", !details.hidden);
    }

    function countryOwnedLocations(countryNumber) {
      return (result.locations || []).filter((loc) => loc.owner === countryNumber);
    }

    function sumField(rows, field) {
      let total = 0;
      let found = false;
      for (const row of rows) {
        if (typeof row[field] === "number") {
          total += row[field];
          found = true;
        }
      }
      return found ? total : undefined;
    }

    function avgField(rows, field) {
      let total = 0;
      let count = 0;
      for (const row of rows) {
        if (typeof row[field] === "number") {
          total += row[field];
          count++;
        }
      }
      return count ? total / count : undefined;
    }

    // Fixed per-pop-type colors matching the game's own population-mapmode
    // legend, so the same pop type reads as the same color in every
    // country's breakdown - a rank-position-indexed palette (previously
    // used here) assigns colors by "which class is biggest in THIS
    // country," so the same class (e.g. nobles) could land on a different
    // color per country depending on local rank. "slaves" isn't a class the
    // game's own legend was confirmed for - given a distinct color anyway
    // so it doesn't collide, but treat that one shade as a best guess.
    const POP_CLASS_COLORS = {
      burghers: "#e8c93a",
      soldiers: "#d64545",
      laborers: "#8a8f98",
      clergy: "#f0f0f0",
      peasants: "#4f9e4f",
      nobles: "#4472c4",
      tribesmen: "#e0872a",
      slaves: "#8d5a8d",
    };
    const POP_CLASS_FALLBACK_COLOR = "#7f8c9a";
    function popClassKey(key) {
      return estateToPopClass(key);
    }

    function popClassColor(key) {
      return POP_CLASS_COLORS[popClassKey(key)] || POP_CLASS_FALLBACK_COLOR;
    }

    function popClassDisplayLabel(key, label) {
      const raw = String(label || key || "").replace(/_estate$/, "");
      const classKey = popClassKey(raw);
      if (classKey === "peasants" || raw === "commoners" || raw === "common") return "Commoners";
      return label ? humanize(label) : humanize(classKey);
    }

    function popClassLabelHtml(key, label) {
      const classKey = popClassKey(key);
      const color = popClassColor(classKey);
      const displayLabel = popClassDisplayLabel(classKey, label);
      const title = displayLabel;
      return `<span class="demographic-label" style="--demographic-color:${color}" title="${escapeHtml(title)}">
        <span class="demographic-swatch" aria-hidden="true"></span>
        <span>${escapeHtml(displayLabel)}</span>
      </span>`;
    }

    // The exact entries here come from the generated EU5 Wiki building pages'
    // Employment column (Common/Rural/Urban buildings). The keyword fallback
    // covers internal save keys such as "marketplace" when they do not match
    // the wiki's display string exactly.
    const BUILDING_POP_TYPE_OVERRIDES = {
      academy_of_sciences: "nobles",
      admiralty: "burghers",
      apothecary: "burghers",
      aqueduct_system: "laborers",
      armory: "soldiers",
      artisan_guilds: "burghers",
      bank: "burghers",
      barracks: "soldiers",
      bastion: "soldiers",
      bridge: "laborers",
      burgher_mansion: "burghers",
      castle: "soldiers",
      cathedral: "clergy",
      city_guard: "soldiers",
      city_walls: "soldiers",
      clay_pit: "laborers",
      commerce_center: "burghers",
      conscription_center: "soldiers",
      construction_center: "laborers",
      cotton_plantation: "slaves",
      dock: "soldiers",
      dry_dock: "soldiers",
      farming_village: "peasants",
      fishing_village: "peasants",
      fortress: "soldiers",
      grand_marketplace: "burghers",
      guild_hall: "burghers",
      hospital: "clergy",
      irrigation: "peasants",
      library: "burghers",
      local_markets: "burghers",
      local_shrine: "clergy",
      lumbermill: "laborers",
      madrasa: "clergy",
      market_village: "peasants",
      market_warehouse: "burghers",
      marketplace: "burghers",
      mason: "laborers",
      merchants_guild: "burghers",
      mission: "clergy",
      monastery: "clergy",
      noble_courts: "nobles",
      noble_villa: "nobles",
      palace: "nobles",
      paper_mill: "laborers",
      plantation: "slaves",
      quarry: "laborers",
      regimental_camp: "soldiers",
      rural_smelter: "laborers",
      salt_collector: "laborers",
      sawmill: "laborers",
      settlement: "peasants",
      shipyard: "soldiers",
      stock_exchange: "burghers",
      stockade: "soldiers",
      stone_quarry: "laborers",
      sugar_plantation: "slaves",
      temple: "clergy",
      textile_mill: "laborers",
      tobacco_plantation: "slaves",
      trade_office: "burghers",
      trading_hub: "burghers",
      training_fields: "soldiers",
      university: "clergy",
      weapon_mill: "laborers",
      wharf: "burghers",
      windmill: "laborers",
    };
    const BUILDING_DISPLAY_NAME_OVERRIDES = {
      banking_office: "Banking Office",
      cloth_guild: "Spinners' Guild",
      dyes_guild: "Dye Maker",
      fine_cloth_guild: "Tailors' Guild",
      furniture_guild: "Carpenters' Guild",
      jewelry_guild: "Jewelers' Guild",
      paper_guild: "Papermakers' Guild",
      pottery_guild: "Potters' Guild",
      pound_lock_canal_infrastructure: "Pound Lock Canal",
      trade_office: "Trade Office",
      weapon_guild: "Weaponsmith",
    };

    function lookupKey(value) {
      return String(value || "")
        .replace(/^building_/, "")
        .replace(/([a-z])([A-Z])/g, "$1_$2")
        .replace(/&/g, " and ")
        .replace(/['’]/g, "")
        .replace(/[^A-Za-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .toLowerCase();
    }

    function buildingPopType(name) {
      const key = lookupKey(name);
      const wikiMap = root.EU5_BUILDING_POP_TYPES || {};
      const title = String(name || "")
        .replace(/^building_/, "")
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
      return (
        BUILDING_POP_TYPE_OVERRIDES[key] ||
        wikiMap[name] ||
        wikiMap[title] ||
        (/(janissary|mamluk|gilman|slave.*barracks|galley_barracks)/i.test(key) ? "slaves" : null) ||
        (/(bastion|castle|fort|stockade|wall|barrack|garrison|armory|arsenal|shipyard|dock|naval|training|warrior|guard|battery|gunnery|conscription|regimental|sergeantry)/i.test(key)
          ? "soldiers"
          : null) ||
        (/(cathedral|temple|church|monastery|madrasa|mission|shrine|clergy|cleric|hospital|university|order|preacher|convent|retreat)/i.test(key) ? "clergy" : null) ||
        (/(palace|noble|manor|court|governor|embassy|villa|parliament|lieutenancy|viceroyalty)/i.test(key) ? "nobles" : null) ||
        (/(plantation)/i.test(key) ? "slaves" : null) ||
        (/(farm|fishing|forest|settlement|village|irrigation|polder|local_school|hunting_ground|pirate|brothel)/i.test(key) ? "peasants" : null) ||
        (/(mill|mine|quarry|pit|foundry|factory|construction|mason|bridge|aqueduct|canal|road|lumber|granary|kiln|smelter|workshop)/i.test(key) ? "laborers" : null) ||
        (/(market|trade|merchant|guild|bank|warehouse|office|customs|tax|library|theater|opera|school|newspaper|apothecary|wharf|port|mint)/i.test(key) ? "burghers" : null) ||
        "burghers"
      );
    }

    function buildingDisplayName(name) {
      const key = lookupKey(name);
      return BUILDING_DISPLAY_NAME_OVERRIDES[key] || humanize(name);
    }

    const POP_CLASS_ORDER = ["burghers", "peasants", "laborers", "clergy", "soldiers", "nobles", "tribesmen", "slaves"];
    function popClassSortIndex(key) {
      const idx = POP_CLASS_ORDER.indexOf(popClassKey(key));
      return idx === -1 ? POP_CLASS_ORDER.length : idx;
    }

    function sortArrow(sortState, key) {
      return sortState && sortState.key === key ? ` <span class="detail-sort-arrow">${sortState.dir === 1 ? "▲" : "▼"}</span>` : "";
    }

    function sortableTh(label, key, sortState) {
      const active = sortState && sortState.key === key;
      return `<th><button type="button" class="detail-sort-btn${active ? " active" : ""}" data-sort-key="${escapeHtml(key)}">${escapeHtml(label)}${sortArrow(sortState, key)}</button></th>`;
    }

    function compareDetailValues(a, b, dir) {
      const aMissing = a === undefined || a === null || Number.isNaN(a);
      const bMissing = b === undefined || b === null || Number.isNaN(b);
      if (aMissing && bMissing) return 0;
      if (aMissing) return 1;
      if (bMissing) return -1;
      if (typeof a === "number" && typeof b === "number") return (a - b) * dir;
      return String(a).localeCompare(String(b)) * dir;
    }

    function buildingNameHtml(name, popType) {
      const color = popClassColor(popType);
      return `<span class="building-name" style="--demographic-color:${color}">
        <span class="demographic-swatch" aria-hidden="true"></span>
        <span>${buildingDisplayName(name)}</span>
      </span>`;
    }

    function buildingItemsForLocation(loc) {
      const items =
        Array.isArray(loc.buildings) && loc.buildings.length
          ? [
              ...loc.buildings
                .reduce((byType, b) => {
                  const key = b.type || "unknown";
                  const item =
                    byType.get(key) ||
                    {
                      name: key,
                      popType: buildingPopType(key),
                      level: 0,
                      employed: 0,
                      profit: 0,
                      count: 0,
                      statuses: new Set(),
                    };
                  item.level += typeof b.level === "number" ? b.level : 0;
                  item.employed += typeof b.employed === "number" ? b.employed : 0;
                  item.profit += typeof b.lastMonthsProfit === "number" ? b.lastMonthsProfit : 0;
                  item.count += 1;
                  if (b.employmentRequirementStatus) item.statuses.add(b.employmentRequirementStatus);
                  byType.set(key, item);
                  return byType;
                }, new Map())
                .values(),
            ].map((item) => ({
              ...item,
              status: item.statuses.size ? [...item.statuses].join(", ") : undefined,
            }))
          : sortedEntries(loc.buildingCounts).map(([name, count]) => ({
              name,
              popType: buildingPopType(name),
              count,
            }));
      return items.sort((a, b) => {
        const aAmount = Array.isArray(loc.buildings) && loc.buildings.length ? a.level : a.count;
        const bAmount = Array.isArray(loc.buildings) && loc.buildings.length ? b.level : b.count;
        return popClassSortIndex(a.popType) - popClassSortIndex(b.popType) || (bAmount || 0) - (aAmount || 0) || String(a.name || "").localeCompare(String(b.name || ""));
      });
    }

    function buildingTabsHtml(loc) {
      const items = buildingItemsForLocation(loc);
      if (!items.length) return `<p>No buildings found</p>`;
      const groups = new Map();
      for (const item of items) {
        const key = popClassKey(item.popType);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
      }
      const orderedGroups = [...groups.entries()].sort((a, b) => popClassSortIndex(a[0]) - popClassSortIndex(b[0]));
      const sortState = locationDetailSort.buildings;
      const tabs = orderedGroups
        .map(([key, group], index) => {
          const count = group.reduce((sum, item) => sum + (item.count || 1), 0);
          return `<button type="button" class="building-pop-tab${index === 0 ? " active" : ""}" data-pop="${escapeHtml(key)}" style="--demographic-color:${popClassColor(key)}">
            <span class="demographic-swatch" aria-hidden="true"></span>
            <span>${humanize(key)}</span>
            <strong>${fmtNum(count, 0)}</strong>
          </button>`;
        })
        .join("");
      const panels = orderedGroups
        .map(([key, group], index) => {
          const amountKey = Array.isArray(loc.buildings) && loc.buildings.length ? "level" : "count";
          const sortedGroup = group.slice().sort((a, b) => {
            const valueFor = (item) => {
              if (sortState.key === "building") return buildingDisplayName(item.name);
              if (sortState.key === "employed") return item.employed;
              if (sortState.key === "profit") return item.profit;
              return item[amountKey];
            };
            const primary = compareDetailValues(valueFor(a), valueFor(b), sortState.dir);
            const fallbackAmount = compareDetailValues(b[amountKey], a[amountKey], 1);
            return primary || fallbackAmount || String(a.name || "").localeCompare(String(b.name || ""));
          });
          const rows = sortedGroup
            .map((item) => {
              const amount = Array.isArray(loc.buildings) && loc.buildings.length ? item.level : item.count;
              return `<tr class="demographic-row" style="--demographic-color:${popClassColor(key)}">
                <td>${buildingNameHtml(item.name, key)}</td>
                <td class="num">${fmtNum(amount, 0)}</td>
                <td class="num">${fmtNum(item.employed, 2)}</td>
                <td class="num">${fmtNum(item.profit, 2)}</td>
              </tr>`;
            })
            .join("");
          return `<div class="building-tab-panel" data-pop="${escapeHtml(key)}"${index === 0 ? "" : " hidden"}>
            <table class="building-detail-table"><thead><tr>
              ${sortableTh("Building", "building", sortState)}
              ${sortableTh(Array.isArray(loc.buildings) && loc.buildings.length ? "Lvl" : "Count", "amount", sortState)}
              ${sortableTh("Emp.", "employed", sortState)}
              ${sortableTh("Profit", "profit", sortState)}
            </tr></thead><tbody>${rows}</tbody></table>
          </div>`;
        })
        .join("");
      return `<div class="building-tabs">${tabs}</div>${panels}`;
    }

    function estateToPopClass(name) {
      const base = String(name || "").replace(/_estate$/, "");
      if (base === "burghers") return "burghers";
      if (base === "nobles") return "nobles";
      if (base === "clergy") return "clergy";
      if (base === "peasants" || base === "commoners" || base === "common") return "peasants";
      if (base === "tribes") return "tribesmen";
      return base;
    }

    function demographicTaxGroup(key) {
      const group = popClassKey(key);
      return group === "laborers" ? "peasants" : group;
    }

    function demographicTaxLabelHtml(key) {
      if (key === "peasants") return popClassLabelHtml(key, "Commoners");
      return popClassLabelHtml(key);
    }

    function demographicTaxSummary(rows) {
      const pop = {};
      const tax = {};
      for (const loc of rows) {
        for (const p of loc.populationClasses || []) {
          if (typeof p.total !== "number") continue;
          const group = demographicTaxGroup(p.name);
          pop[group] = (pop[group] || 0) + p.total;
        }
        for (const [estate, value] of Object.entries(loc.estateTax || {})) {
          if (typeof value !== "number") continue;
          const group = demographicTaxGroup(estate);
          tax[group] = (tax[group] || 0) + value;
        }
      }
      const keys = [...new Set(Object.keys(pop).concat(Object.keys(tax)))].sort((a, b) => (pop[b] || 0) - (pop[a] || 0));
      const totalPop = keys.reduce((sum, key) => sum + (pop[key] || 0), 0);
      const totalTax = keys.reduce((sum, key) => sum + (tax[key] || 0), 0);
      return { keys, pop, tax, totalPop, totalTax, overallEfficiency: totalPop > 0 ? totalTax / totalPop : undefined };
    }

    function demographicTaxSortValue(summary, key, sortKey) {
      const pop = summary.pop[key] || 0;
      const tax = summary.tax[key] || 0;
      if (sortKey === "group") return popClassDisplayLabel(key, key);
      if (sortKey === "share") return summary.totalPop ? pop / summary.totalPop : undefined;
      if (sortKey === "tax") return tax;
      if (sortKey === "per1k") return pop > 0 ? tax / pop : undefined;
      return pop;
    }

    function demographicTaxChartHtml(rows) {
      const summary = demographicTaxSummary(rows);
      if (!summary.keys.length || !summary.totalPop) return "";
      const sortState = countryDetailSort.demographicTax;
      const sortedKeys = summary.keys.slice().sort((a, b) => {
        const primary = compareDetailValues(demographicTaxSortValue(summary, a, sortState.key), demographicTaxSortValue(summary, b, sortState.key), sortState.dir);
        return primary || popClassSortIndex(a) - popClassSortIndex(b) || String(a).localeCompare(String(b));
      });
      let cursor = 0;
      const segments = summary.keys.map((key) => {
        const share = ((summary.pop[key] || 0) / summary.totalPop) * 100;
        const start = cursor;
        cursor += share;
        return `${popClassColor(key)} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`;
      });
      let taxCursor = 0;
      const taxSegments = summary.totalTax
        ? summary.keys.map((key) => {
            const share = ((summary.tax[key] || 0) / summary.totalTax) * 100;
            const start = taxCursor;
            taxCursor += share;
            return `${popClassColor(key)} ${start.toFixed(2)}% ${taxCursor.toFixed(2)}%`;
          })
        : ["rgba(255,255,255,0.08) 0% 100%"];
      const rowsHtml = sortedKeys
        .map((key) => {
          const pop = summary.pop[key] || 0;
          const tax = summary.tax[key] || 0;
          const popShare = summary.totalPop ? pop / summary.totalPop : undefined;
          const efficiency = pop > 0 ? tax / pop : undefined;
          return `<tr class="demographic-row" style="--demographic-color:${popClassColor(key)}">
            <td>${demographicTaxLabelHtml(key)}</td>
            <td class="num">${fmtCompactPopulation(pop)}</td>
            <td class="num">${fmtPercent(popShare, 1)}</td>
            <td class="num">${fmtNum(tax, 3)}</td>
            <td class="num">${fmtNum(efficiency, 4)}</td>
          </tr>`;
        })
        .join("");
      return `
        <section class="location-detail-section">
          <h4>Demographic Taxation</h4>
          <div class="demographic-chart">
            <div class="demographic-pie" style="background:conic-gradient(${segments.join(", ")})">
              <div class="demographic-pie-tax" style="background:conic-gradient(${taxSegments.join(", ")})"></div>
            </div>
            <div class="demographic-summary">
              ${detailStat("Weighted Tax / 1k People", fmtNum(summary.overallEfficiency, 4) + " tax")}
              ${detailStat("Total Group Tax", fmtNum(summary.totalTax, 3) + " tax")}
            </div>
          </div>
          <table class="demographic-tax-table">
            <thead><tr>
              ${sortableTh("Group", "group", sortState)}
              ${sortableTh("Pop.", "pop", sortState)}
              ${sortableTh("Share", "share", sortState)}
              ${sortableTh("Tax", "tax", sortState)}
              ${sortableTh("/1k", "per1k", sortState)}
            </tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </section>`;
    }

    function definitionNameFor(map, id, fallbackPrefix) {
      const def = map.get(id);
      const raw = def && (def.name || def.key || def.definition);
      return raw ? humanize(raw) : fmtMaybeId(id, fallbackPrefix);
    }

    function cleanDefinitionName(value) {
      if (!value) return "&mdash;";
      return humanize(String(value).replace(/_province$/i, ""));
    }

    function countryDetailsHtml(countryNumber) {
      const country = countryByNumber.get(countryNumber);
      if (!country) return "";
      const rows = countryOwnedLocations(countryNumber);
      const capitalMeta = country.capital && locationsMeta[country.capital];
      const visibleCountryPlayers = visiblePlayers(country.players, mapState.excludedPlayers);
      const playerText = visibleCountryPlayers.length ? visibleCountryPlayers.map(titleCaseName).join(", ") : "AI";
      const totalPop = sumField(rows, "population");
      const totalDev = sumField(rows, "development");
      const totalTax = sumField(rows, "tax");
      const displayedPopulation = typeof country.population === "number" ? country.population : totalPop;
      const stats = [
        detailStat("Tag", escapeHtml(country.tag || "?")),
        detailStat("Player", escapeHtml(playerText)),
        detailStat("Government", country.governmentType ? escapeHtml(country.governmentType) : "&mdash;"),
        detailStat("Rank", fmtNum(country.scorePlace, 0)),
        detailStat("Locations", fmtNum(rows.length, 0)),
        detailStat("Capital", capitalMeta ? humanize(capitalMeta.name) : fmtMaybeId(country.capital, "Location")),
        detailStat("Population", fmtPopulation(displayedPopulation)),
        detailStat("Development", typeof totalDev === "number" ? fmtNum(totalDev, 1) : "&mdash;"),
        detailStat("Avg Development", typeof totalDev === "number" && rows.length ? fmtNum(totalDev / rows.length, 2) + " / location" : "&mdash;"),
        detailStat("Tax Base", typeof totalTax === "number" ? fmtNum(totalTax, 3) + " tax" : "&mdash;"),
        detailStat("Avg Control", fmtPercent(avgField(rows, "control"), 1)),
        detailStat("Avg Prosperity", fmtPercent(avgField(rows, "prosperity"), 1)),
        detailStat("Avg Market Access", fmtPercent(avgField(rows, "marketAccess"), 1)),
        detailStat("Treasury", fmtNum(country.gold, 1)),
        detailStat("Income/mo", fmtNum(country.lastMonthGoldIncome, 2)),
        detailStat("Profit", fmtNum(country.profit, 1)),
        detailStat("Manpower", fmtNum(country.manpower, 2)),
        detailStat("Manpower / 1k People", typeof country.manpower === "number" && displayedPopulation > 0 ? fmtNum(country.manpower / displayedPopulation, 4) : "&mdash;"),
      ].join("");
      return `
        <div class="location-detail-head">
          <div>
            <h3>${escapeHtml(country.tag || `Country #${countryNumber}`)}</h3>
            <div class="location-detail-sub">${escapeHtml(playerText === "AI" ? playerText : titleCaseName(playerText))} - Country #${countryNumber}</div>
          </div>
          <button type="button" class="location-detail-close country-detail-close" title="Clear country focus">x</button>
        </div>
        <h4 class="location-detail-stats-label">National Stats</h4>
        <div class="location-detail-stats">${stats}</div>
        ${demographicTaxChartHtml(rows)}
        <section class="location-detail-section">
          <h4>Map Focus</h4>
          <p>Numeric heat maps are scaled to this country's owned locations.</p>
        </section>
      `;
    }

    function locationDetailsHtml(id) {
      const meta = locationsMeta[id] || {};
      const loc = locByNumber.get(id) || {};
      const owner = countryLabel(loc.owner);
      const controller = countryLabel(loc.controller);
      const overlord = subjectToOverlord.has(loc.owner) ? countryLabel(subjectToOverlord.get(loc.owner)) : null;
      const type = meta.type || "unknown";
      const provinceName = meta.province || loc.province;
      const headerContext = [
        { label: "Province", value: cleanDefinitionName(provinceName) },
        { label: "Nation", value: owner ? escapeHtml(owner) : "&mdash;" },
        { label: "Controller", value: controller ? escapeHtml(controller) : "&mdash;" },
      ];

      // Sea/lake tiles have no settlement to speak of - ownership,
      // development, population, tax, control/prosperity, raw material, and
      // culture/religion/language are all structurally absent (confirmed
      // against real save data: every sampled sea location has those fields
      // undefined). What a sea tile DOES genuinely carry is trade-node
      // membership (market/secondBestMarket/marketAttraction show real
      // values), so only that subset renders for water instead of a wall of
      // "-" placeholders.
      const isWater = type === "sea" || type === "lake";
      const allStats = [
        !isWater && detailStat("Overlord", overlord ? escapeHtml(overlord) : "&mdash;"),
        !isWater && detailStat("Rank", humanize(loc.rank)),
        !isWater && detailStat("Development", typeof loc.development === "number" ? fmtNum(loc.development, 2) : "&mdash;"),
        !isWater && detailStat("Population", fmtPopulation(loc.population)),
        !isWater && detailStat("Pop Groups", fmtNum(loc.popCount, 0)),
        !isWater && detailStat("Tax Base", typeof loc.tax === "number" ? fmtNum(loc.tax, 4) + " tax" : "&mdash;"),
        !isWater && detailStat("Possible Tax", typeof loc.possibleTax === "number" ? fmtNum(loc.possibleTax, 4) + " tax" : "&mdash;"),
        !isWater && detailStat("Control", fmtPercent(loc.control, 1)),
        !isWater && detailStat("Prosperity", fmtPercent(loc.prosperity, 1)),
        detailStat("Market", loc.market !== undefined && loc.market !== null ? escapeHtml(marketName(loc.market)) : "&mdash;"),
        detailStat("Second Market", loc.secondBestMarket !== undefined && loc.secondBestMarket !== null ? escapeHtml(marketName(loc.secondBestMarket)) : "&mdash;"),
        detailStat("Market Access", fmtPercent(loc.marketAccess, 1)),
        detailStat("Market Attraction", fmtPercent(loc.marketAttraction, 1)),
        !isWater && detailStat("Raw Material", humanize(loc.rawMaterial)),
        !isWater && detailStat("Raw Material Capacity", typeof loc.maxRawMaterialWorkers === "number" ? fmtNum(loc.maxRawMaterialWorkers, 0) + " RGO capacity" : "&mdash;"),
        !isWater && detailStat("Culture", definitionNameFor(cultureByNumber, loc.culture, "Culture")),
        !isWater && detailStat("Religion", definitionNameFor(religionByNumber, loc.religion, "Religion")),
        !isWater && detailStat("Language", humanize(loc.language)),
      ];
      const stats = allStats.filter(Boolean).join("");

      const estateTaxRows = sortedEntries(loc.estateTax)
        .map(
          ([name, value]) =>
            `<tr class="demographic-row" style="--demographic-color:${popClassColor(name)}"><td>${popClassLabelHtml(name, name)}</td><td class="num">${fmtNum(value, 4)}</td></tr>`
        )
        .join("");
      // Institutions store either a 0-100 embrace/progress number, or the
      // literal string "yes" once fully established (no numeric field at
      // that point) - normalize "yes" to 100 so it renders as a percentage
      // instead of falling through fmtNum() as "NaN".
      const institutionRows = sortedEntries(loc.institutions)
        .map(([name, value]) => `<tr><td>${humanize(name)}</td><td class="num">${fmtNum(value === "yes" ? 100 : value, 1)}%</td></tr>`)
        .join("");
      const popRows = (loc.populationClasses || [])
        .map(
          (p) =>
            `<tr class="demographic-row" style="--demographic-color:${popClassColor(p.name)}"><td>${popClassLabelHtml(p.name)}</td><td class="num">${fmtCompactPopulation(p.total)}</td><td class="num">${fmtCompactPopulation(p.unemployed)}</td></tr>`
        )
        .join("");

      function section(title, body, emptyText) {
        return `<section class="location-detail-section"><h4>${escapeHtml(title)}</h4>${body || `<p>${escapeHtml(emptyText || "No data")}</p>`}</section>`;
      }

      return `
        <div class="location-detail-head">
          <div>
            <h3>${escapeHtml(meta.name ? titleCaseName(meta.name) : `Location #${id}`)}</h3>
            <div class="location-detail-sub">Location #${id} - ${escapeHtml(titleCaseName(type))}</div>
          </div>
          <button type="button" class="location-detail-close" title="Close location details">x</button>
        </div>
        <div class="location-context-row">
          ${headerContext
            .map((item) => `<div class="location-context-pill"><span>${escapeHtml(item.label)}</span><strong>${item.value}</strong></div>`)
            .join("")}
        </div>
        <h4 class="location-detail-stats-label">Location Stats</h4>
        <div class="location-detail-stats">${stats}</div>
        ${
          isWater
            ? ""
            : `
        ${section("Demography", popRows ? `<table class="location-demography-table"><thead><tr><th>Class</th><th>Total</th><th>Unemp.</th></tr></thead><tbody>${popRows}</tbody></table>` : "", "No population data")}
        ${section("Estate Tax", estateTaxRows ? `<table class="location-two-col-table"><thead><tr><th>Estate</th><th>Tax Base</th></tr></thead><tbody>${estateTaxRows}</tbody></table>` : "", "No estate tax data")}
        ${section("Institutions", institutionRows ? `<table class="location-two-col-table"><thead><tr><th>Institution</th><th>Progress</th></tr></thead><tbody>${institutionRows}</tbody></table>` : "", "No institution data")}
        <section class="location-detail-section building-detail-section">
          <h4>Buildings</h4>
          ${buildingTabsHtml(loc)}
        </section>
      `
        }
      `;
    }

    function clearLocationDetails() {
      selectedLocationId = 0;
      details.hidden = true;
      details.innerHTML = '<div class="location-detail-empty">Click a land location to inspect ownership, population, tax, buildings, and local metrics.</div>';
      updateMapBodyClasses();
      render();
    }

    function clearCountryDetails() {
      selectedCountryId = 0;
      mapState.focusCountry = 0;
      updateMetricScale(0);
      countryDetails.hidden = true;
      countryDetails.innerHTML = "";
      updateMapBodyClasses();
      redraw();
    }

    function clearMapFocus() {
      selectedLocationId = 0;
      selectedCountryId = 0;
      mapState.focusCountry = 0;
      mapState.focusTradeGood = null;
      updateMetricScale(0);
      details.hidden = true;
      details.innerHTML = '<div class="location-detail-empty">Click a land location to inspect ownership, population, tax, buildings, and local metrics.</div>';
      countryDetails.hidden = true;
      countryDetails.innerHTML = "";
      updateMapBodyClasses();
      redraw();
    }

    function showCountryDetails(countryNumber, shouldRedraw) {
      if (!countryByNumber.has(countryNumber)) return;
      selectedCountryId = countryNumber;
      mapState.focusCountry = countryNumber;
      updateMetricScale(countryNumber);
      countryDetails.hidden = false;
      countryDetails.innerHTML = countryDetailsHtml(countryNumber);
      const close = countryDetails.querySelector(".country-detail-close");
      if (close) close.addEventListener("click", clearCountryDetails);
      countryDetails.querySelectorAll(".demographic-tax-table .detail-sort-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const key = btn.dataset.sortKey || "pop";
          const sort = countryDetailSort.demographicTax;
          sort.dir = sort.key === key ? -sort.dir : key === "group" ? 1 : -1;
          sort.key = key;
          showCountryDetails(countryNumber, false);
        });
      });
      updateMapBodyClasses();
      if (shouldRedraw !== false) redraw();
    }

    function showLocationDetails(id) {
      if (!locationsMeta[id] && !locByNumber.has(id)) return;
      const loc = locByNumber.get(id);
      if (currentMode === modes.trade && loc && loc.rawMaterial) {
        mapState.focusTradeGood = loc.rawMaterial;
        updateMetricScale(mapState.focusCountry);
      }
      if (loc && loc.owner) showCountryDetails(loc.owner, false);
      // A sea/lake tile is never owned, so it can't ever hit the branch
      // above - but a nation view from a PREVIOUS click can still be open.
      // Clear it back to the global mapmode rather than leaving a stale
      // nation highlight up while looking at an unrelated sea tile's panel.
      else if (isWaterLUT[id] && selectedCountryId) clearCountryDetails();
      selectedLocationId = id;
      details.hidden = false;
      details.innerHTML = locationDetailsHtml(id);
      attachLocationDetailHandlers(id);
      updateMapBodyClasses();
      redraw();
    }

    function attachBuildingTabHandlers(activePop) {
      if (activePop) {
        details.querySelectorAll(".building-pop-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.pop === activePop));
        details.querySelectorAll(".building-tab-panel").forEach((panel) => {
          panel.hidden = panel.dataset.pop !== activePop;
        });
      }
      details.querySelectorAll(".building-pop-tab").forEach((btn) => {
        btn.addEventListener("click", () => {
          const pop = btn.dataset.pop;
          details.querySelectorAll(".building-pop-tab").forEach((tab) => tab.classList.toggle("active", tab === btn));
          details.querySelectorAll(".building-tab-panel").forEach((panel) => {
            panel.hidden = panel.dataset.pop !== pop;
          });
        });
      });
    }

    function attachLocationDetailHandlers(id, activePop) {
      const close = details.querySelector(".location-detail-close");
      if (close) close.addEventListener("click", clearLocationDetails);
      details.querySelectorAll(".building-detail-table .detail-sort-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const currentTab = details.querySelector(".building-pop-tab.active");
          const currentPop = currentTab && currentTab.dataset.pop;
          const key = btn.dataset.sortKey || "amount";
          const sort = locationDetailSort.buildings;
          sort.dir = sort.key === key ? -sort.dir : key === "building" ? 1 : -1;
          sort.key = key;
          details.innerHTML = locationDetailsHtml(id);
          attachLocationDetailHandlers(id, currentPop);
        });
      });
      attachBuildingTabHandlers(activePop);
    }

    // Walks up the overlord chain (capped at 8 hops) and returns the
    // player-controlled country number at its ROOT (a player's vassal, its
    // own sub-vassal, etc. all resolve to the same root), or 0 if the chain
    // never reaches a player - so the border wraps the whole visible realm,
    // not just the core provinces, matching how a player actually thinks of
    // "my nation" on the map. Returning the root country's *identity*
    // (rather than a plain true/false "is this player-owned") matters for
    // border detection below: two adjacent but different player realms both
    // need to register as player-owned AND as different from each other.
    const realmRootCache = new Map();
    function playerRealmRoot(countryNumber) {
      if (realmRootCache.has(countryNumber)) return realmRootCache.get(countryNumber);
      let current = countryNumber;
      const chain = [];
      let root = 0;
      for (let hops = 0; hops < 8 && current != null; hops++) {
        if (realmRootCache.has(current)) {
          root = realmRootCache.get(current);
          break;
        }
        chain.push(current);
        const country = countryByNumber.get(current);
        if (country && visiblePlayers(country.players, mapState.excludedPlayers).length > 0) {
          root = current;
          break;
        }
        current = subjectToOverlord.get(current);
      }
      for (const c of chain) realmRootCache.set(c, root);
      return root;
    }

    const isSeaLUT = new Uint8Array(maxId + 1);
    const isLakeLUT = new Uint8Array(maxId + 1);
    const isWaterLUT = new Uint8Array(maxId + 1);
    const isNeutralLandLUT = new Uint8Array(maxId + 1);
    const playerRealmLUT = new Uint32Array(maxId + 1);
    const ownerLUT = new Uint32Array(maxId + 1);
    for (let id = 0; id <= maxId; id++) {
      const loc = locByNumber.get(id);
      const meta = locationsMeta[id];
      const sea = !!meta && meta.type === "sea";
      const lake = !!meta && meta.type === "lake";
      const water = sea || lake;
      isSeaLUT[id] = sea ? 1 : 0;
      isLakeLUT[id] = lake ? 1 : 0;
      isWaterLUT[id] = water ? 1 : 0;
      isNeutralLandLUT[id] = meta && !water && (!loc || !loc.owner) ? 1 : 0;
      playerRealmLUT[id] = loc && loc.owner && !water ? playerRealmRoot(loc.owner) : 0;
      ownerLUT[id] = loc && loc.owner && !water ? loc.owner : 0;
    }
    const neutralEnclosedRealmLUT = computeNeutralEnclosedRealms(idGrid, maxId, isWaterLUT, isNeutralLandLUT, playerRealmLUT);

    // Rebuilt on mode switch / vassal-shading toggle (not per animation
    // frame - see render()/scheduleRender() below). lut* is the current
    // mapmode's per-id fill color; border* is always the location's
    // POLITICAL color (regardless of active mapmode) darkened, so the
    // player-realm outline stays a meaningful "whose land is this" cue no
    // matter which mapmode is on screen, matching the old white-outline's
    // "always visible" intent.
    function buildLUTs() {
      const lutR = new Uint8ClampedArray(maxId + 1);
      const lutG = new Uint8ClampedArray(maxId + 1);
      const lutB = new Uint8ClampedArray(maxId + 1);
      const borderR = new Uint8ClampedArray(maxId + 1);
      const borderG = new Uint8ClampedArray(maxId + 1);
      const borderB = new Uint8ClampedArray(maxId + 1);
      for (let id = 0; id <= maxId; id++) {
        const water = isWaterLUT[id];
        const c = water ? WATER_COLOR : currentMode.colorFor(id);
        lutR[id] = c[0];
        lutG[id] = c[1];
        lutB[id] = c[2];
        const loc = locByNumber.get(id);
        const politicalBase = loc && loc.owner ? politicalColor(loc.owner) : water ? WATER_COLOR : NO_DATA_COLOR;
        const dark = shadeColor(politicalBase, BORDER_DARKEN);
        borderR[id] = dark[0];
        borderG[id] = dark[1];
        borderB[id] = dark[2];
      }
      return {
        lutR,
        lutG,
        lutB,
        borderR,
        borderG,
        borderB,
        isWater: isWaterLUT,
        isSea: isSeaLUT,
        isLake: isLakeLUT,
        ownerLUT,
        playerRealmLUT,
        neutralEnclosedRealmLUT,
        playerLabels,
        tradeGoodLabels:
          currentMode === modes.trade && mapState.focusTradeGood
            ? tradeGoodLabels.filter((label) => label.material === mapState.focusTradeGood)
            : null,
      };
    }

    let luts = null;
    const DPR = Math.min(window.devicePixelRatio || 1, MAX_RENDER_DPR);
    const view = { scale: 1, offX: 0, offY: 0 };

    function fit() {
      const rect = canvasWrap.getBoundingClientRect();
      return computeFit(rect.width, rect.height);
    }

    function resetView() {
      const f = fit();
      view.scale = f.scale;
      view.offX = f.offX;
      view.offY = f.offY;
    }

    function firstPlayerCountry() {
      for (const player of result.players || []) {
        if (mapState.excludedPlayers.has(player.name)) continue;
        const country = countryByNumber.get(player.countryNumber);
        if (country) return country;
      }
      return (result.countries || []).find((country) => visiblePlayers(country.players, mapState.excludedPlayers).length) || null;
    }

    function estimateFootprints(targetIds, step) {
      const footprints = new Map();
      function touch(id, x, y) {
        let fp = footprints.get(id);
        if (!fp) {
          fp = { minX: x, minY: y, maxX: x, maxY: y, sumX: 0, sumY: 0, n: 0 };
          footprints.set(id, fp);
        }
        fp.minX = Math.min(fp.minX, x);
        fp.minY = Math.min(fp.minY, y);
        fp.maxX = Math.max(fp.maxX, x);
        fp.maxY = Math.max(fp.maxY, y);
        fp.sumX += x;
        fp.sumY += y;
        fp.n++;
      }

      for (let y = 0; y < MAP_H; y += step) {
        const row = y * MAP_W;
        for (let x = 0; x < MAP_W; x += step) {
          const id = idGrid[row + x];
          if (targetIds.has(id)) touch(id, x, y);
        }
      }
      return footprints;
    }

    function zoomToInitialPlayerCountry() {
      const country = firstPlayerCountry();
      if (!country) {
        resetView();
        return;
      }
      const ownedIds = new Set();
      for (const loc of result.locations || []) {
        if (loc.owner === country.number && locationsMeta[loc.number] && locationsMeta[loc.number].type !== "sea") {
          ownedIds.add(loc.number);
        }
      }
      if (!ownedIds.size) {
        resetView();
        return;
      }

      const sampleStep = 12;
      const footprints = estimateFootprints(ownedIds, sampleStep);
      let bounds = null;
      for (const fp of footprints.values()) {
        if (!bounds) bounds = { minX: fp.minX, minY: fp.minY, maxX: fp.maxX, maxY: fp.maxY };
        else {
          bounds.minX = Math.min(bounds.minX, fp.minX);
          bounds.minY = Math.min(bounds.minY, fp.minY);
          bounds.maxX = Math.max(bounds.maxX, fp.maxX);
          bounds.maxY = Math.max(bounds.maxY, fp.maxY);
        }
      }
      if (!bounds) {
        resetView();
        return;
      }

      const capitalFp = country.capital ? footprints.get(country.capital) : null;
      const centerX = capitalFp && capitalFp.n ? capitalFp.sumX / capitalFp.n : (bounds.minX + bounds.maxX) / 2;
      const centerY = capitalFp && capitalFp.n ? capitalFp.sumY / capitalFp.n : (bounds.minY + bounds.maxY) / 2;
      const rect = canvasWrap.getBoundingClientRect();
      const f = fit();
      const countryW = Math.max(120, bounds.maxX - bounds.minX + sampleStep * 8);
      const countryH = Math.max(120, bounds.maxY - bounds.minY + sampleStep * 8);
      const scale = Math.min((rect.width * 0.74) / countryW, (rect.height * 0.74) / countryH);
      const maxScale = f.scale * 25;
      view.scale = Math.max(f.scale, Math.min(maxScale, scale));
      view.offX = rect.width / 2 - centerX * view.scale;
      view.offY = rect.height / 2 - centerY * view.scale;
      view.offX = clampAxis(view.offX, view.scale, MAP_W, rect.width);
      view.offY = clampAxis(view.offY, view.scale, MAP_H, rect.height);
    }

    let renderQueued = false;
    function scheduleRender() {
      if (renderQueued) return;
      renderQueued = true;
      requestAnimationFrame(() => {
        renderQueued = false;
        render();
      });
    }

    function render() {
      const rect = canvasWrap.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      if (glRenderer) {
        const destW = Math.max(1, Math.round(rect.width * DPR));
        const destH = Math.max(1, Math.round(rect.height * DPR));
        const s = view.scale * DPR;
        const step = 1 / s;
        const box = step > 1.5 ? 3 : 1;
        const drawLocationBorders = s >= LOCATION_BOUNDARY_MIN_SCALE;
        glRenderer.render(destW, destH, view, DPR, box, drawLocationBorders, true, selectedLocationId);
        if (labelCanvas.width !== destW) labelCanvas.width = destW;
        if (labelCanvas.height !== destH) labelCanvas.height = destH;
        labelCtx.clearRect(0, 0, destW, destH);
        drawLabelOverlay(labelCtx, destW, destH, DPR, s, view.offX * DPR, view.offY * DPR, luts.playerLabels, luts.tradeGoodLabels, view.scale);
        return;
      }
      if (!ctx) ctx = canvas.getContext("2d");
      renderViewport(ctx, canvas, rect.width, rect.height, DPR, view, idGrid, luts, selectedLocationId);
    }

    function renderLegend() {
      if (!currentMode.legend) {
        legendEl.innerHTML = "";
        legendEl.hidden = true;
        return;
      }
      legendEl.hidden = false;
      const legend = currentMode.legend();
      if (legend.type === "gradient") {
        // Sampled at many points (not just a handful of fixed stops) so any
        // non-linear/non-smooth curve - Markets' access gradient (peaks at
        // 75% instead of rising monotonically), or the heat palette's flat
        // classed bands with hard edges at specific percentiles - actually
        // shows its real shape instead of getting smoothed away between two
        // far-apart stops.
        const STEPS = 60;
        const stops = [];
        for (let i = 0; i <= STEPS; i++) {
          const t = i / STEPS;
          const c = legend.colorAt(t);
          stops.push(`rgb(${c[0]},${c[1]},${c[2]}) ${(t * 100).toFixed(1)}%`);
        }
        const gradient = `linear-gradient(to right, ${stops.join(", ")})`;
        const note = legend.note ? `<div class="map-legend-note">${escapeHtml(legend.note)}</div>` : "";
        legendEl.innerHTML = `
          <div class="map-legend-gradient">
            <span>${escapeHtml(legend.minLabel)}</span>
            <div class="map-legend-gradient-bar" style="background:${gradient}"></div>
            <span>${escapeHtml(legend.maxLabel)}</span>
          </div>${note}`;
        return;
      }
      const items = legend.items
        .map(
          (it) =>
            `<span class="map-legend-item"><span class="map-legend-swatch" style="background:rgb(${it.color[0]},${it.color[1]},${it.color[2]})"></span>${escapeHtml(it.label)}</span>`
        )
        .join("");
      const overflow = legend.overflow > 0 ? `<span class="map-legend-overflow">+${legend.overflow} more</span>` : "";
      const note = legend.note ? `<div class="map-legend-note">${escapeHtml(legend.note)}</div>` : "";
      legendEl.innerHTML = items + overflow + note;
    }

    const redraw = () => {
      luts = buildLUTs();
      if (glRenderer === undefined) {
        // First redraw() of the session - now that a real `luts` exists,
        // attempt to stand up the WebGL2 renderer. `null` means WebGL2 isn't
        // available at all; render()/showLocationDetails() etc. fall back to
        // the CPU renderViewport() for the rest of this session either way.
        glRenderer = createGLMapRenderer(canvas, idImage, maxId, luts) || null;
      }
      if (glRenderer) glRenderer.setModeLuts(luts);
      render();
      renderLegend();
      updateTradeFocusControl();
    };

    // Declared here (rather than down by setupPanZoom, where it's also used)
    // so it's also in scope for the mode-icon <img> listener below - scoping
    // that listener to the same session-teardown signal, rather than leaving
    // it permanently attached, matches the pattern already used for every
    // other listener in this function.
    const abortController = new AbortController();
    Object.keys(modes).forEach((key) => {
      const btn = document.createElement("button");
      btn.className = "map-mode-btn";
      btn.title = modes[key].label;
      if (MAP_MODE_ICONS[key]) {
        btn.innerHTML = `<img class="map-mode-icon" src="${MAP_MODE_ICONS[key]}" alt="" loading="lazy"><span>${escapeHtml(modes[key].label)}</span>`;
        const img = btn.querySelector("img");
        img.addEventListener("error", () => img.remove(), { signal: abortController.signal });
      } else {
        btn.textContent = modes[key].label;
      }
      btn.addEventListener("click", () => {
        toolbar.querySelectorAll(".map-mode-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        currentMode = modes[key];
        redraw();
      });
      if (modes[key] === currentMode) btn.classList.add("active");
      toolbar.appendChild(btn);
    });

    const vassalLabel = document.createElement("label");
    vassalLabel.className = "map-vassal-toggle";
    const vassalCheckbox = document.createElement("input");
    vassalCheckbox.type = "checkbox";
    vassalCheckbox.checked = mapState.vassalShading;
    vassalCheckbox.addEventListener("change", () => {
      mapState.vassalShading = vassalCheckbox.checked;
      redraw();
    });
    vassalLabel.appendChild(vassalCheckbox);
    vassalLabel.appendChild(document.createTextNode("Shade vassals by overlord"));
    toolbar.appendChild(vassalLabel);

    const tradeFocusBtn = document.createElement("button");
    tradeFocusBtn.type = "button";
    tradeFocusBtn.className = "map-mode-btn map-trade-focus-btn";
    tradeFocusBtn.hidden = true;
    tradeFocusBtn.addEventListener("click", () => {
      mapState.focusTradeGood = null;
      updateMetricScale(mapState.focusCountry);
      redraw();
    });
    toolbar.appendChild(tradeFocusBtn);

    function updateTradeFocusControl() {
      const focused = currentMode === modes.trade && mapState.focusTradeGood;
      tradeFocusBtn.hidden = !focused;
      if (focused) tradeFocusBtn.textContent = `Clear ${humanize(mapState.focusTradeGood)} focus`;
    }

    const resetBtn = document.createElement("button");
    resetBtn.textContent = "Reset zoom";
    resetBtn.className = "map-mode-btn map-reset-btn";
    resetBtn.addEventListener("click", () => {
      resetView();
      render();
    });
    toolbar.appendChild(resetBtn);

    zoomToInitialPlayerCountry();
    redraw();
    setupPanZoom(canvasWrap, canvas, tooltip, idGrid, locationsMeta, () => currentMode, view, fit, scheduleRender, showLocationDetails, abortController.signal);
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Escape") return;
        const target = e.target;
        if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || "")) return;
        if (!selectedLocationId && !selectedCountryId && !mapState.focusCountry && !mapState.focusTradeGood) return;
        e.preventDefault();
        clearMapFocus();
      },
      { signal: abortController.signal }
    );

    // The canvas backing store now matches the wrap's own CSS box (not a
    // fixed 16384x8192), so unlike before, a container resize needs a
    // re-render - keep the user's current pan/zoom, just re-clamp it to the
    // new box instead of snapping back to the fitted view.
    const resizeObserver = new ResizeObserver(() => {
      const rect = canvasWrap.getBoundingClientRect();
      view.offX = clampAxis(view.offX, view.scale, MAP_W, rect.width);
      view.offY = clampAxis(view.offY, view.scale, MAP_H, rect.height);
      scheduleRender();
    });
    resizeObserver.observe(canvasWrap);
    activeSession = { abortController, resizeObserver };
  }

  // Wheel-to-zoom (toward cursor) + click-drag pan. Unlike the old CSS-
  // transform approach, every change here re-renders just the visible
  // viewport (scheduleRender, rAF-throttled) rather than transforming an
  // always-fully-rendered giant canvas. `signal` scopes the window-level
  // drag listeners to this session so createMapView() can tear them down
  // when a new save replaces this one (see the note above createMapView).
  function setupPanZoom(wrap, canvas, tooltip, idGrid, locationsMeta, getMode, view, getFit, scheduleRender, onLocationClick, signal) {
    function clamp() {
      const rect = wrap.getBoundingClientRect();
      view.offX = clampAxis(view.offX, view.scale, MAP_W, rect.width);
      view.offY = clampAxis(view.offY, view.scale, MAP_H, rect.height);
    }

    wrap.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const rect = wrap.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const minScale = getFit().scale;
        const maxScale = minScale * 25;
        const factor = e.deltaY < 0 ? 1.25 : 0.8;
        const newScale = Math.max(minScale, Math.min(maxScale, view.scale * factor));
        // Keep the point under the cursor fixed on screen while zooming.
        const srcX = (cx - view.offX) / view.scale;
        const srcY = (cy - view.offY) / view.scale;
        view.offX = cx - srcX * newScale;
        view.offY = cy - srcY * newScale;
        view.scale = newScale;
        clamp();
        scheduleRender();
      },
      { passive: false }
    );

    let dragging = false;
    let dragMoved = false;
    let startX, startY, startOffX, startOffY;

    function locationIdFromEvent(e) {
      const rect = wrap.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      const srcX = Math.floor((screenX - view.offX) / view.scale);
      const srcY = Math.floor((screenY - view.offY) / view.scale);
      if (srcX < 0 || srcY < 0 || srcX >= MAP_W || srcY >= MAP_H) return null;
      return { id: idGrid[srcY * MAP_W + srcX], screenX, screenY, srcX, srcY };
    }

    wrap.addEventListener("mousedown", (e) => {
      dragging = true;
      dragMoved = false;
      startX = e.clientX;
      startY = e.clientY;
      startOffX = view.offX;
      startOffY = view.offY;
      canvas.style.cursor = "grabbing";
    });
    window.addEventListener(
      "mousemove",
      (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved = true;
        if (!dragMoved) return;
        view.offX = startOffX + dx;
        view.offY = startOffY + dy;
        clamp();
        tooltip.hidden = true;
        scheduleRender();
      },
      { signal }
    );
    window.addEventListener(
      "mouseup",
      () => {
        const moved = dragMoved;
        dragging = false;
        canvas.style.cursor = "grab";
        if (moved) {
          scheduleRender();
          setTimeout(() => (dragMoved = false), 0);
        }
      },
      { signal }
    );

    canvas.addEventListener("mousemove", (e) => {
      if (dragMoved) return;
      const hit = locationIdFromEvent(e);
      if (!hit) {
        tooltip.hidden = true;
        return;
      }
      const meta = locationsMeta[hit.id];
      if (!meta) {
        tooltip.hidden = true;
        return;
      }
      const extra = getMode().tooltipFor(hit.id);
      tooltip.hidden = false;
      tooltip.style.left = hit.screenX + 12 + "px";
      tooltip.style.top = hit.screenY + 12 + "px";
      const name = titleCaseName(meta.name);
      tooltip.textContent = extra ? `${name} - ${extra}` : name;
    });
    canvas.addEventListener("click", (e) => {
      if (dragMoved) return;
      const hit = locationIdFromEvent(e);
      if (hit && onLocationClick) onLocationClick(hit.id);
    });
    canvas.addEventListener("mouseleave", () => {
      tooltip.hidden = true;
    });
  }

  root.MapView = { createMapView };
})(typeof self !== "undefined" ? self : this);
