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
  const OUTSIDE_MAP_COLOR = [12, 16, 21];
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

  async function loadLocationIdGrid() {
    const img = await loadImage("map_data/location_ids.png");
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
    return ids;
  }

  async function loadLocationNames() {
    const res = await fetch("map_data/locations.json");
    return res.json();
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

  // Numeric mapmodes: low is bad/sparse (black/red), high is good/rich
  // (green/blue). Palettes differ by mode so development and population
  // remain visually distinct.
  function heatColor(t, palette) {
    t = Math.max(0, Math.min(1, t));
    const stops =
      palette === "development"
        ? [
            [42, 18, 18],
            [156, 42, 38],
            [64, 174, 102],
            [77, 166, 226],
          ]
        : [
            [8, 10, 12],
            [137, 28, 42],
            [35, 154, 104],
            [90, 188, 255],
          ];
    const scaled = t * (stops.length - 1);
    const idx = Math.min(stops.length - 2, Math.floor(scaled));
    const u = scaled - idx;
    const a = stops[idx];
    const b = stops[idx + 1];
    return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * u));
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

    function computeMetricMaxes(countryNumber) {
      const maxes = { development: 1, population: 1, tradeGood: 1 };
      for (const l of result.locations || []) {
        if (countryNumber && l.owner !== countryNumber) continue;
        if (typeof l.development === "number" && l.development > maxes.development) maxes.development = l.development;
        if (typeof l.population === "number" && l.population > maxes.population) maxes.population = l.population;
        if (mapState.focusTradeGood && l.rawMaterial === mapState.focusTradeGood && typeof l.maxRawMaterialWorkers === "number" && l.maxRawMaterialWorkers > maxes.tradeGood) {
          maxes.tradeGood = l.maxRawMaterialWorkers;
        }
      }
      return maxes;
    }

    mapState.metricMaxes = computeMetricMaxes(mapState.focusCountry);

    function updateMetricScale(countryNumber) {
      mapState.metricMaxes = computeMetricMaxes(countryNumber);
    }

    function filteredHeatColor(loc, field, palette) {
      if (!loc || typeof loc[field] !== "number") return NO_DATA_COLOR;
      if (!isFocusedLoc(loc)) return NON_PLAYER_MUTED;
      const max = (mapState.metricMaxes && mapState.metricMaxes[field]) || 1;
      return heatColor(loc[field] / max, palette);
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

    function politicalColor(ownerNumber) {
      if (mapState.vassalShading && subjectToOverlord.has(ownerNumber)) {
        const overlord = subjectToOverlord.get(ownerNumber);
        return shadeColor(countryColor(overlord), shadeAmountForId(ownerNumber));
      }
      return countryColor(ownerNumber);
    }

    function isPlayerCountry(countryNumber) {
      const country = countryByNumber.get(countryNumber);
      return !!(country && country.players && country.players.length > 0);
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

    function gradientLegend(maxValue, formatFn, palette) {
      return { type: "gradient", colorAt: (t) => heatColor(t, palette), minLabel: formatFn(0), maxLabel: formatFn(maxValue) };
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
        legend: () =>
          categoricalLegend(
            (loc) => loc.owner || null,
            (owner) => politicalColor(owner),
            (owner) => (countryByNumber.get(owner) || {}).tag || `#${owner}`,
            12
          ),
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
          return loc.owner === root ? `${country.tag} - ${rootCountry.players.map(titleCaseName).join(", ")}` : `${country.tag} (${rootCountry.tag} Subject)`;
        },
        legend: () =>
          categoricalLegend(
            (loc) => modePlayerRealmRoot(loc.owner) || null,
            (owner) => countryColor(owner),
            (owner) => {
              const c = countryByNumber.get(owner);
              return `${c.tag} - ${c.players.map(titleCaseName).join(", ")}`;
            },
            20
          ),
      },
      development: {
        label: "Development",
        colorFor(id) {
          const loc = locByNumber.get(id);
          if (!loc || typeof loc.development !== "number") return NO_DATA_COLOR;
          return filteredHeatColor(loc, "development", "development");
        },
        tooltipFor(id) {
          const loc = locByNumber.get(id);
          return loc && typeof loc.development === "number" ? `Development: ${loc.development.toFixed(1)}` : null;
        },
        legend: () => gradientLegend((mapState.metricMaxes && mapState.metricMaxes.development) || 1, (v) => v.toFixed(0) + " pts", "development"),
      },
      population: {
        label: "Population",
        colorFor(id) {
          const loc = locByNumber.get(id);
          if (!loc || typeof loc.population !== "number") return NO_DATA_COLOR;
          return filteredHeatColor(loc, "population", "population");
        },
        tooltipFor(id) {
          const loc = locByNumber.get(id);
          return loc && typeof loc.population === "number" ? `Population: ${fmtPopulation(loc.population)}` : null;
        },
        legend: () => gradientLegend((mapState.metricMaxes && mapState.metricMaxes.population) || 1, (v) => fmtPopulation(v), "population"),
      },
      control: {
        label: "Control",
        colorFor(id) {
          const loc = locByNumber.get(id);
          if (!loc || typeof loc.control !== "number") return NO_DATA_COLOR;
          if (!isFocusedLoc(loc)) return NON_PLAYER_MUTED;
          return heatColor(loc.control, "development");
        },
        tooltipFor(id) {
          const loc = locByNumber.get(id);
          return loc && typeof loc.control === "number" ? `Control: ${fmtPercent(loc.control, 1)}` : null;
        },
        legend: () => gradientLegend(1, (v) => fmtPercent(v, 0), "development"),
      },
      prosperity: {
        label: "Prosperity",
        colorFor(id) {
          const loc = locByNumber.get(id);
          if (!loc || typeof loc.prosperity !== "number") return NO_DATA_COLOR;
          if (!isFocusedLoc(loc)) return NON_PLAYER_MUTED;
          return heatColor(loc.prosperity, "population");
        },
        tooltipFor(id) {
          const loc = locByNumber.get(id);
          return loc && typeof loc.prosperity === "number" ? `Prosperity: ${fmtPercent(loc.prosperity, 1)}` : null;
        },
        legend: () => gradientLegend(1, (v) => fmtPercent(v, 0), "population"),
      },
      marketAccess: {
        label: "Market Access",
        colorFor(id) {
          const loc = locByNumber.get(id);
          if (!loc || typeof loc.marketAccess !== "number") return NO_DATA_COLOR;
          if (!isFocusedLoc(loc)) return NON_PLAYER_MUTED;
          return heatColor(loc.marketAccess, "development");
        },
        tooltipFor(id) {
          const loc = locByNumber.get(id);
          const market = loc && marketName(loc.market);
          return loc && typeof loc.marketAccess === "number" ? `Market Access: ${fmtPercent(loc.marketAccess, 1)}${market ? ` (${market})` : ""}` : null;
        },
        legend: () => gradientLegend(1, (v) => fmtPercent(v, 0), "development"),
      },
      trade: {
        label: "Trade Goods",
        colorFor(id) {
          const loc = locByNumber.get(id);
          if (!loc || !loc.rawMaterial) return NO_DATA_COLOR;
          if (mapState.focusTradeGood && loc.rawMaterial !== mapState.focusTradeGood) return NON_PLAYER_MUTED;
          return colorForString(loc.rawMaterial);
        },
        tooltipFor(id) {
          const loc = locByNumber.get(id);
          if (!loc || !loc.rawMaterial) return null;
          const name = titleCaseName(loc.rawMaterial);
          return typeof loc.maxRawMaterialWorkers === "number" ? `${name}: ${fmtNum(loc.maxRawMaterialWorkers, 0)} RGO capacity` : name;
        },
        legend: () => {
          return categoricalLegend(
            (loc) => loc.rawMaterial || null,
            (material) => colorForString(material),
            (material) => material.replace(/_/g, " "),
            14
          );
        },
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
        legend: () =>
          categoricalLegend(
            (loc) => loc.religion || null,
            (id) => definitionColor(religionByNumber.get(id), id),
            (id) => definitionName(religionByNumber.get(id), "Religion", id),
            12
          ),
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
        legend: () =>
          categoricalLegend(
            (loc) => loc.culture || null,
            (id) => definitionColor(cultureByNumber.get(id), id),
            (id) => definitionName(cultureByNumber.get(id), "Culture", id),
            12
          ),
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
  function renderViewport(ctx, canvas, wrapCssW, wrapCssH, dpr, view, idGrid, luts, selectedId) {
    const destW = Math.max(1, Math.round(wrapCssW * dpr));
    const destH = Math.max(1, Math.round(wrapCssH * dpr));
    if (canvas.width !== destW) canvas.width = destW;
    if (canvas.height !== destH) canvas.height = destH;

    const { lutR, lutG, lutB, borderR, borderG, borderB, isWater, isSea, isLake, ownerLUT, playerRealmLUT, neutralEnclosedRealmLUT, playerLabels, tradeGoodLabels } = luts;
    const s = view.scale * dpr;
    const ox = view.offX * dpr;
    const oy = view.offY * dpr;
    const fast = !!view.fast;

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
    const drawDetailedBorders = !fast && s >= LOCATION_BOUNDARY_MIN_SCALE;
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
    if (!fast) {
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
          const rightCoastOutline = rightInMap && rightSea && ownedHere && !water;
          const downCoastOutline = downInMap && downSea && ownedHere && !water;
          if (rightRealmBorder || rightCoastOutline) {
            boundary[di] = 1;
            if (rightRealmBorder) boundary[di + 1] = 1;
            hasPlayerBoundary = true;
          }
          if (downRealmBorder || downCoastOutline) {
            boundary[di] = 1;
            if (downRealmBorder) boundary[di + destW] = 1;
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

    if (!fast && playerLabels && playerLabels.length) {
      ctx.save();
      ctx.font = `600 ${Math.round(16 * dpr)}px ${PLAYER_LABEL_FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = Math.max(4, 4 * dpr);
      ctx.strokeStyle = "rgba(8, 8, 8, 0.94)";
      ctx.fillStyle = "rgba(244, 232, 188, 0.98)";
      for (const label of playerLabels) {
        const x = label.x * s + ox;
        const y = label.y * s + oy;
        if (x < -80 || y < -20 || x > destW + 80 || y > destH + 20) continue;
        const text = label.text.toUpperCase();
        ctx.strokeText(text, x, y);
        ctx.fillText(text, x, y);
      }
      ctx.restore();
    }

    if (!fast && tradeGoodLabels && tradeGoodLabels.length && view.scale > 0.28) {
      ctx.save();
      ctx.font = `700 ${Math.round(11 * dpr)}px ${PLAYER_LABEL_FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = Math.max(3, 3 * dpr);
      ctx.strokeStyle = "rgba(5, 7, 10, 0.88)";
      ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
      for (const label of tradeGoodLabels) {
        const x = label.x * s + ox;
        const y = label.y * s + oy;
        if (x < -40 || y < -20 || x > destW + 40 || y > destH + 20) continue;
        ctx.strokeText(label.text, x, y);
        ctx.fillText(label.text, x, y);
      }
      ctx.restore();
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

  function computePlayerLabels(idGrid, countryByNumber) {
    // Straightforward: find each player country's capital location on the
    // map and put the label directly on it. Scans the full grid once (a
    // plain Map lookup per pixel) rather than sampling on a stride, so even
    // a tiny capital province is guaranteed to be found.
    const capitalIdToCountry = new Map();
    for (const country of countryByNumber.values()) {
      if (country.players && country.players.length && country.capital) {
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
      labels.push({ x, y, text: country.players.map(titleCaseName).join(", ") });
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

  async function createMapView(container, result) {
    if (activeSession) {
      activeSession.abortController.abort();
      activeSession.resizeObserver.disconnect();
      activeSession = null;
    }

    const [idGrid, locationsMeta] = await Promise.all([loadLocationIdGrid(), loadLocationNames()]);
    applyProvinceOwnerFallback(result, locationsMeta);

    container.innerHTML = "";
    const toolbar = document.createElement("div");
    toolbar.className = "map-toolbar";
    const mapBody = document.createElement("div");
    mapBody.className = "map-body";
    const canvasWrap = document.createElement("div");
    canvasWrap.className = "map-canvas-wrap";
    const canvas = document.createElement("canvas");
    const tooltip = document.createElement("div");
    tooltip.className = "map-tooltip";
    tooltip.hidden = true;
    const countryDetails = document.createElement("div");
    countryDetails.className = "country-details";
    countryDetails.hidden = true;
    const leaderLine = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    leaderLine.classList.add("map-leader-line");
    leaderLine.setAttribute("aria-hidden", "true");
    leaderLine.hidden = true;
    leaderLine.innerHTML = '<line class="map-leader-line-path" x1="0" y1="0" x2="0" y2="0"></line><circle class="map-leader-line-dot" cx="0" cy="0" r="4"></circle>';
    const details = document.createElement("div");
    details.className = "location-details";
    details.hidden = true;
    details.innerHTML = '<div class="location-detail-empty">Click a land location to inspect ownership, population, tax, buildings, and local metrics.</div>';
    const legendEl = document.createElement("div");
    legendEl.className = "map-legend";
    canvasWrap.appendChild(canvas);
    canvasWrap.appendChild(tooltip);
    mapBody.appendChild(canvasWrap);
    mapBody.appendChild(toolbar);
    mapBody.appendChild(legendEl);
    mapBody.appendChild(countryDetails);
    mapBody.appendChild(details);
    mapBody.appendChild(leaderLine);
    container.appendChild(mapBody);

    const ctx = canvas.getContext("2d");
    const mapState = { vassalShading: true, focusCountry: 0, focusTradeGood: null };
    const { modes, politicalColor, marketName, updateMetricScale } = buildMapModes(result, locationsMeta, mapState);
    let currentMode = modes.political;
    let selectedLocationId = 0;
    let selectedCountryId = 0;
    let selectedSourcePoint = null;
    let maxId = 0;
    for (let i = 0; i < idGrid.length; i++) if (idGrid[i] > maxId) maxId = idGrid[i];

    const countryByNumber = result.countriesByNumber || new Map((result.countries || []).map((c) => [c.number, c]));
    const locByNumber = new Map((result.locations || []).map((l) => [l.number, l]));
    const subjectToOverlord = new Map((result.dependencies || []).map((d) => [d.subject, d.overlord]));
    const cultureByNumber = new Map((result.cultures || []).map((c) => [c.number, c]));
    const religionByNumber = new Map((result.religions || []).map((r) => [r.number, r]));
    const playerLabels = computePlayerLabels(idGrid, countryByNumber);
    const tradeGoodLabels = computeTradeGoodLabels(idGrid, locByNumber, locationsMeta);

    function countryLabel(countryNumber) {
      const country = countryByNumber.get(countryNumber);
      if (!country) return countryNumber ? `#${countryNumber}` : null;
      const playerText = country.players && country.players.length ? ` - ${country.players.map(titleCaseName).join(", ")}` : "";
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

    function popClassLabelHtml(key, label) {
      const classKey = popClassKey(key);
      const color = popClassColor(classKey);
      const title = String(label || classKey).replace(/_/g, " ");
      return `<span class="demographic-label" style="--demographic-color:${color}" title="${escapeHtml(title)}">
        <span class="demographic-swatch" aria-hidden="true"></span>
        <span>${label ? humanize(label) : humanize(classKey)}</span>
      </span>`;
    }

    const ROAD_ICON = wikiIcon("Global road building time.png");

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
      return items.sort((a, b) => popClassSortIndex(a.popType) - popClassSortIndex(b.popType) || String(a.name || "").localeCompare(String(b.name || "")));
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
          const rows = group
            .map((item) => {
              const amount = Array.isArray(loc.buildings) && loc.buildings.length ? item.level : item.count;
              return `<tr class="demographic-row" style="--demographic-color:${popClassColor(key)}">
                <td>${buildingNameHtml(item.name, key)}</td>
                <td class="num">${fmtNum(amount, 0)}</td>
                <td class="num">${fmtNum(item.employed, 2)}</td>
                <td>${humanize(item.status)}</td>
                <td class="num">${fmtNum(item.profit, 2)}</td>
              </tr>`;
            })
            .join("");
          return `<div class="building-tab-panel" data-pop="${escapeHtml(key)}"${index === 0 ? "" : " hidden"}>
            <table><thead><tr><th>Building</th><th>${Array.isArray(loc.buildings) && loc.buildings.length ? "Level" : "Count"}</th><th>Employed</th><th>Status</th><th>Profit</th></tr></thead><tbody>${rows}</tbody></table>
          </div>`;
        })
        .join("");
      return `<div class="building-tabs">${tabs}</div>${panels}`;
    }

    function roadSummaryHtml(loc) {
      const entries = sortedEntries(loc.roadCounts);
      const total = entries.reduce((sum, [, count]) => sum + count, 0);
      const chips = entries.length
        ? entries
            .map(
              ([name, count]) => `<span class="road-chip">
                <img src="${ROAD_ICON}" alt="" aria-hidden="true">
                <span>${humanize(name)}</span>
                <strong>${fmtNum(count, 0)}</strong>
              </span>`
            )
            .join("")
        : `<span class="road-chip empty"><img src="${ROAD_ICON}" alt="" aria-hidden="true"><span>No road assets found</span></span>`;
      return `<section class="location-detail-section road-assets-section">
        <h4>Roads</h4>
        <div class="road-assets-head">
          <img src="${ROAD_ICON}" alt="" aria-hidden="true">
          <strong>${total ? fmtNum(total, 0) + " road asset" + (total === 1 ? "" : "s") : "No road assets found"}</strong>
        </div>
        <div class="road-chip-row">${chips}</div>
      </section>`;
    }

    function estateToPopClass(name) {
      const base = String(name || "").replace(/_estate$/, "");
      if (base === "burghers") return "burghers";
      if (base === "nobles") return "nobles";
      if (base === "clergy") return "clergy";
      if (base === "peasants") return "peasants";
      if (base === "tribes") return "tribesmen";
      return base;
    }

    function demographicTaxSummary(rows) {
      const pop = {};
      const tax = {};
      for (const loc of rows) {
        for (const p of loc.populationClasses || []) {
          if (typeof p.total === "number") pop[p.name] = (pop[p.name] || 0) + p.total;
        }
        for (const [estate, value] of Object.entries(loc.estateTax || {})) {
          if (typeof value !== "number") continue;
          const group = estateToPopClass(estate);
          tax[group] = (tax[group] || 0) + value;
        }
      }
      const keys = [...new Set(Object.keys(pop).concat(Object.keys(tax)))].sort((a, b) => (pop[b] || 0) - (pop[a] || 0));
      const totalPop = keys.reduce((sum, key) => sum + (pop[key] || 0), 0);
      const totalTax = keys.reduce((sum, key) => sum + (tax[key] || 0), 0);
      return { keys, pop, tax, totalPop, totalTax, overallEfficiency: totalPop > 0 ? totalTax / totalPop : undefined };
    }

    function demographicTaxChartHtml(rows) {
      const summary = demographicTaxSummary(rows);
      if (!summary.keys.length || !summary.totalPop) return "";
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
      const rowsHtml = summary.keys
        .map((key) => {
          const pop = summary.pop[key] || 0;
          const tax = summary.tax[key] || 0;
          const popShare = summary.totalPop ? pop / summary.totalPop : undefined;
          const efficiency = pop > 0 ? tax / pop : undefined;
          return `<tr class="demographic-row" style="--demographic-color:${popClassColor(key)}">
            <td>${popClassLabelHtml(key)}</td>
            <td class="num">${fmtPopulation(pop)}</td>
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
              ${detailStat("Weighted Tax / 1k People", fmtNum(summary.overallEfficiency, 4))}
              ${detailStat("Total Group Tax", fmtNum(summary.totalTax, 3))}
            </div>
          </div>
          <table>
            <thead><tr><th>Group</th><th>Population</th><th>Share</th><th>Tax</th><th>Tax/1k</th></tr></thead>
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
      const playerText = country.players && country.players.length ? country.players.map(titleCaseName).join(", ") : "AI";
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

      const stats = [
        detailStat("Overlord", overlord ? escapeHtml(overlord) : "&mdash;"),
        detailStat("Rank", humanize(loc.rank)),
        detailStat("Development", typeof loc.development === "number" ? fmtNum(loc.development, 2) : "&mdash;"),
        detailStat("Population", fmtPopulation(loc.population)),
        detailStat("Pop Groups", fmtNum(loc.popCount, 0)),
        detailStat("Tax Base", typeof loc.tax === "number" ? fmtNum(loc.tax, 4) + " tax" : "&mdash;"),
        detailStat("Possible Tax", typeof loc.possibleTax === "number" ? fmtNum(loc.possibleTax, 4) + " tax" : "&mdash;"),
        detailStat("Control", fmtPercent(loc.control, 1)),
        detailStat("Prosperity", fmtPercent(loc.prosperity, 1)),
        detailStat("Market", loc.market !== undefined && loc.market !== null ? escapeHtml(marketName(loc.market)) : "&mdash;"),
        detailStat("Second Market", loc.secondBestMarket !== undefined && loc.secondBestMarket !== null ? escapeHtml(marketName(loc.secondBestMarket)) : "&mdash;"),
        detailStat("Market Access", fmtPercent(loc.marketAccess, 1)),
        detailStat("Market Attraction", fmtPercent(loc.marketAttraction, 1)),
        detailStat("Raw Material", humanize(loc.rawMaterial)),
        detailStat("Raw Material Capacity", fmtNum(loc.maxRawMaterialWorkers, 0)),
        detailStat("Culture", definitionNameFor(cultureByNumber, loc.culture, "Culture")),
        detailStat("Religion", definitionNameFor(religionByNumber, loc.religion, "Religion")),
        detailStat("Language", humanize(loc.language)),
      ].join("");

      const estateTaxRows = sortedEntries(loc.estateTax)
        .map(
          ([name, value]) =>
            `<tr class="demographic-row" style="--demographic-color:${popClassColor(name)}"><td>${popClassLabelHtml(name, name)}</td><td class="num">${fmtNum(value, 4)}</td></tr>`
        )
        .join("");
      const institutionRows = sortedEntries(loc.institutions)
        .map(([name, value]) => `<tr><td>${humanize(name)}</td><td class="num">${fmtNum(value, 1)}</td></tr>`)
        .join("");
      const popRows = (loc.populationClasses || [])
        .map(
          (p) =>
            `<tr class="demographic-row" style="--demographic-color:${popClassColor(p.name)}"><td>${popClassLabelHtml(p.name)}</td><td class="num">${fmtPopulation(p.total)}</td><td class="num">${fmtPopulation(p.unemployed)}</td><td class="num">${fmtPopulation(p.employedInRgo)}</td></tr>`
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
        <div class="location-detail-stats">${stats}</div>
        ${section("Demography", popRows ? `<table><thead><tr><th>Class</th><th>Total</th><th>Unemployed</th><th>RGO</th></tr></thead><tbody>${popRows}</tbody></table>` : "", "No population data")}
        ${section("Estate Tax", estateTaxRows ? `<table><tbody>${estateTaxRows}</tbody></table>` : "", "No estate tax data")}
        ${section("Institutions", institutionRows ? `<table><tbody>${institutionRows}</tbody></table>` : "", "No institution data")}
        ${roadSummaryHtml(loc)}
        <section class="location-detail-section building-detail-section">
          <h4>Buildings</h4>
          ${buildingTabsHtml(loc)}
        </section>
      `;
    }

    function hideLeaderLine() {
      leaderLine.hidden = true;
      leaderLine.style.display = "none";
      const line = leaderLine.querySelector(".map-leader-line-path");
      const dot = leaderLine.querySelector(".map-leader-line-dot");
      if (line) {
        line.setAttribute("x1", "0");
        line.setAttribute("y1", "0");
        line.setAttribute("x2", "0");
        line.setAttribute("y2", "0");
      }
      if (dot) {
        dot.setAttribute("cx", "0");
        dot.setAttribute("cy", "0");
      }
    }

    function updateLeaderLine() {
      if (!selectedLocationId || !selectedSourcePoint || details.hidden) {
        hideLeaderLine();
        return;
      }
      const bodyRect = mapBody.getBoundingClientRect();
      const canvasRect = canvasWrap.getBoundingClientRect();
      const detailsRect = details.getBoundingClientRect();
      const x = canvasRect.left - bodyRect.left + selectedSourcePoint.x * view.scale + view.offX;
      const y = canvasRect.top - bodyRect.top + selectedSourcePoint.y * view.scale + view.offY;
      const canvasX = x - (canvasRect.left - bodyRect.left);
      const canvasY = y - (canvasRect.top - bodyRect.top);
      if (canvasX < 0 || canvasY < 0 || canvasX > canvasRect.width || canvasY > canvasRect.height) {
        hideLeaderLine();
        return;
      }
      leaderLine.hidden = false;
      leaderLine.style.display = "";
      leaderLine.setAttribute("viewBox", `0 0 ${Math.max(1, bodyRect.width)} ${Math.max(1, bodyRect.height)}`);
      const line = leaderLine.querySelector(".map-leader-line-path");
      const dot = leaderLine.querySelector(".map-leader-line-dot");
      const panelX = detailsRect.left - bodyRect.left;
      const panelTop = detailsRect.top - bodyRect.top;
      const panelBottom = detailsRect.bottom - bodyRect.top;
      const panelY = Math.max(panelTop + 18, Math.min(panelBottom - 18, y));
      line.setAttribute("x1", x);
      line.setAttribute("y1", y);
      line.setAttribute("x2", panelX);
      line.setAttribute("y2", panelY);
      dot.setAttribute("cx", x);
      dot.setAttribute("cy", y);
    }

    function clearLocationDetails() {
      selectedLocationId = 0;
      selectedSourcePoint = null;
      hideLeaderLine();
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
      selectedSourcePoint = null;
      selectedCountryId = 0;
      mapState.focusCountry = 0;
      mapState.focusTradeGood = null;
      updateMetricScale(0);
      hideLeaderLine();
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
      updateMapBodyClasses();
      if (shouldRedraw !== false) redraw();
    }

    function showLocationDetails(id, hit) {
      if (!locationsMeta[id] && !locByNumber.has(id)) return;
      const loc = locByNumber.get(id);
      if (currentMode === modes.trade && loc && loc.rawMaterial) {
        mapState.focusTradeGood = loc.rawMaterial;
        updateMetricScale(mapState.focusCountry);
      }
      if (loc && loc.owner) showCountryDetails(loc.owner, false);
      selectedLocationId = id;
      selectedSourcePoint = hit && typeof hit.srcX === "number" && typeof hit.srcY === "number" ? { x: hit.srcX, y: hit.srcY } : null;
      details.hidden = false;
      details.innerHTML = locationDetailsHtml(id);
      const close = details.querySelector(".location-detail-close");
      if (close) close.addEventListener("click", clearLocationDetails);
      details.querySelectorAll(".building-pop-tab").forEach((btn) => {
        btn.addEventListener("click", () => {
          const pop = btn.dataset.pop;
          details.querySelectorAll(".building-pop-tab").forEach((tab) => tab.classList.toggle("active", tab === btn));
          details.querySelectorAll(".building-tab-panel").forEach((panel) => {
            panel.hidden = panel.dataset.pop !== pop;
          });
        });
      });
      updateMapBodyClasses();
      redraw();
      updateLeaderLine();
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
        if (country && country.players && country.players.length > 0) {
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
        const country = countryByNumber.get(player.countryNumber);
        if (country) return country;
      }
      return (result.countries || []).find((country) => country.players && country.players.length) || null;
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
      renderViewport(ctx, canvas, rect.width, rect.height, DPR, view, idGrid, luts, selectedLocationId);
      updateLeaderLine();
    }

    function renderLegend() {
      if (!currentMode.legend) {
        legendEl.innerHTML = "";
        return;
      }
      const legend = currentMode.legend();
      if (legend.type === "gradient") {
        const c0 = legend.colorAt(0);
        const c1 = legend.colorAt(0.33);
        const c2 = legend.colorAt(0.66);
        const c3 = legend.colorAt(1);
        const gradient = `linear-gradient(to right, rgb(${c0[0]},${c0[1]},${c0[2]}) 0%, rgb(${c1[0]},${c1[1]},${c1[2]}) 33%, rgb(${c2[0]},${c2[1]},${c2[2]}) 66%, rgb(${c3[0]},${c3[1]},${c3[2]}) 100%)`;
        legendEl.innerHTML = `
          <div class="map-legend-gradient">
            <span>${escapeHtml(legend.minLabel)}</span>
            <div class="map-legend-gradient-bar" style="background:${gradient}"></div>
            <span>${escapeHtml(legend.maxLabel)}</span>
          </div>`;
        return;
      }
      const items = legend.items
        .map(
          (it) =>
            `<span class="map-legend-item"><span class="map-legend-swatch" style="background:rgb(${it.color[0]},${it.color[1]},${it.color[2]})"></span>${escapeHtml(it.label)}</span>`
        )
        .join("");
      const overflow = legend.overflow > 0 ? `<span class="map-legend-overflow">+${legend.overflow} more</span>` : "";
      legendEl.innerHTML = items + overflow;
    }

    const redraw = () => {
      luts = buildLUTs();
      render();
      renderLegend();
      updateTradeFocusControl();
    };

    Object.keys(modes).forEach((key) => {
      const btn = document.createElement("button");
      btn.className = "map-mode-btn";
      btn.title = modes[key].label;
      if (MAP_MODE_ICONS[key]) {
        btn.innerHTML = `<img class="map-mode-icon" src="${MAP_MODE_ICONS[key]}" alt="" loading="lazy"><span>${escapeHtml(modes[key].label)}</span>`;
        const img = btn.querySelector("img");
        img.addEventListener("error", () => img.remove());
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
    const abortController = new AbortController();
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

    let settleTimer = null;
    function scheduleSettledRender() {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        view.fast = false;
        scheduleRender();
      }, 90);
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
        view.fast = true;
        scheduleRender();
        scheduleSettledRender();
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
        view.fast = true;
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
          view.fast = false;
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
      if (hit && onLocationClick) onLocationClick(hit.id, hit);
    });
    canvas.addEventListener("mouseleave", () => {
      tooltip.hidden = true;
    });
  }

  root.MapView = { createMapView };
})(typeof self !== "undefined" ? self : this);
