// Builds game_data/building-costs.json: a static per-building-type base cost
// table (in ducats), so the website can compute a "buildings value" economic
// metric per country from a save's own building_manager records
// (js/clausewitz.js's/clausewitz-binary.js's extractBuildingFields - just
// {type, level, location, owner, ...}, no cost of any kind stored in the
// save itself - confirmed by dumping raw building records directly).
//
// There is NO single flat "cost" field per building type in the game files.
// Confirmed (with the user, who plays the game, plus real in-game tooltip
// screenshots) that ordinary building costs are resolved through THREE
// different mechanisms depending on the building:
//   1. `building_types/*.txt`'s `price = <name>` - a small set (~17) of
//      mostly special/estate/event/unique buildings that reference a NAMED
//      entry in `prices/*.txt`, giving flat currency amounts (gold, but also
//      religious_influence/stability/legitimacy/etc. for a few non-economic
//      ones - only the `gold` component counts toward a ducat value here).
//      A referenced amount can itself be a scripted value name (e.g.
//      `gold = build_price_age_of_tradition`) needing one more lookup into
//      `script_values/default_values.txt`.
//   2. Every OTHER building's real one-time "Market Building Costs" (the
//      flat number shown in the in-game build tooltip, confirmed via 7 real
//      screenshots against 7 different buildings) is an IMPLICIT default
//      selected by the building's age tier + its `expensive = yes/no` flag:
//      `prices/01_buildings.txt` defines `p_building_age_N_*` (50/100/200/
//      400/800/1200 gold for ages 1-6) and `p_expensive_building_age_N_*`
//      (200/400/800/1600/3200/5000) - literally `p_building_` or
//      `p_expensive_building_` + the age key string. A building's age is
//      whatever `advances/*.txt` entry has `unlock_building = <this
//      building>` and `age = age_N_...`; if no advance unlocks it at all,
//      it's available from game start = age_1_traditions. Verified exactly
//      (all 7/7 match): marketplace/granary/mason (no unlock advance, not
//      expensive) = 50g; armory/dock/gun_smith (age_2_renaissance) = 100g;
//      printing_press_shop (age_3_discovery) = 200g. This is now resolved
//      the same way in `buildBuildingCosts()` below (source: "age_tier").
//      One heuristic risk: a building with no unlock-advance trace defaults
//      to age_1 - correctly excluded from this default when it's gated
//      `allow`/`country_potential`/`potential = { always = no }` (true event/
//      decision-granted wonders like versailles/zwinger/wisselbank, which
//      are never normally constructable and so have no real construction
//      cost at all), but a handful of oddball buildings unlocked through
//      some OTHER non-advance mechanism (not yet found) could still land on
//      an incorrect age_1 default. Not fully audited - see
//      docs/BUILDINGS_VALUE_METRIC_TODO.md if a specific building's value
//      looks wrong.
//   3. `construction_demand = <name>` (a named `goods_demand/*.txt` goods
//      basket) is NOT a one-time construction cost despite the filename
//      (`goods_demand/building_construction_costs.txt`) and the
//      `category = building_construction` tag on every entry - it's a
//      MONTHLY UPKEEP rate paid during construction, confirmed by the user
//      and separately confirmed by the in-game tooltip showing it under
//      "Requirements ... to progress" (a per-month goods draw), distinct
//      from the flat "Market Building Costs" number. Never treat this as a
//      cost.
//
// `increase_per_level_cost` (only set on a handful of building types, e.g.
// `construction_center = 0.5`; unset = 0, i.e. no compounding, confirmed via
// full-directory grep - no global default define exists) scales the cost of
// each successive level geometrically on top of the base price: level k's
// incremental cost = baseCost * (1 + r)^(k-1). The total cost to reach level
// L is baseCost * ((1+r)^L - 1) / r (or baseCost * L when r = 0) - see
// js/app.js's buildingValueToLevel(), which must use the exact same formula.
//
// Usage: node tools/build-building-costs.js [--root="C:\path\to\Europa Universalis V"]
// Output: game_data/building-costs.json (gitignored, same treatment as the
// rest of game_data/ - bundled into the deployed site at build time by
// scripts/build-netlify-site.js, never committed to git).
const fs = require("fs");
const path = require("path");
const cw = require("../js/clausewitz.js");

const DEFAULT_GAME_ROOT = "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Europa Universalis V";

function stripCommentsAndBom(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/#[^\n]*/g, "");
}

function parseEntitiesInFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const text = stripCommentsAndBom(raw);
  const scanner = new cw.Scanner(text, 0, text.length);
  try {
    const body = scanner.parseBlockBody();
    return body && typeof body === "object" && !Array.isArray(body) ? body : {};
  } catch (err) {
    console.warn(`  [skip: parse error] ${filePath}: ${err.message}`);
    return {};
  }
}

function parseAllEntitiesInDir(dir) {
  const out = {};
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".txt"));
  } catch {
    return out;
  }
  for (const f of files) {
    Object.assign(out, parseEntitiesInFile(path.join(dir, f)));
  }
  return out;
}

// script_values/default_values.txt is a flat "name = number" list (plus some
// more complex scripted formulas this tool doesn't need to understand - only
// plain numeric assignments are read, anything else is left unresolved).
function parseScriptValues(filePath) {
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return out;
  }
  const text = stripCommentsAndBom(raw);
  const scanner = new cw.Scanner(text, 0, text.length);
  const body = scanner.parseBlockBody();
  if (!body || typeof body !== "object") return out;
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === "number") out[key] = value;
  }
  return out;
}

function resolveGold(priceEntry, scriptValues) {
  if (!priceEntry || typeof priceEntry !== "object") return 0;
  const gold = priceEntry.gold;
  if (typeof gold === "number") return gold;
  if (typeof gold === "string" && typeof scriptValues[gold] === "number") return scriptValues[gold];
  return 0; // non-gold-priced (religious_influence/stability/etc.) or unresolvable
}

// True if a trigger block explicitly says `always = no` - the game's own
// signal that a building is never normally constructable (event/decision-
// granted wonders like versailles, zwinger, wisselbank), so it has no real
// construction cost to infer.
function isAlwaysNoGated(block) {
  return !!block && typeof block === "object" && (block.always === false || block.always === "no");
}

// buildingKey -> age key string (e.g. "age_2_renaissance"), from whichever
// advances/*.txt entry has `unlock_building = <buildingKey>` and an `age`.
function buildAgeByBuilding(root) {
  const advances = parseAllEntitiesInDir(path.join(root, "game", "in_game", "common", "advances"));
  const ageByBuilding = {};
  for (const def of Object.values(advances)) {
    if (def && typeof def === "object" && typeof def.unlock_building === "string" && typeof def.age === "string") {
      ageByBuilding[def.unlock_building] = def.age;
    }
  }
  return ageByBuilding;
}

function buildBuildingCosts(root) {
  const priceByKey = parseAllEntitiesInDir(path.join(root, "game", "in_game", "common", "prices"));
  const scriptValues = parseScriptValues(path.join(root, "game", "main_menu", "common", "script_values", "default_values.txt"));
  const buildingEntities = parseAllEntitiesInDir(path.join(root, "game", "in_game", "common", "building_types"));
  const ageByBuilding = buildAgeByBuilding(root);

  const costs = {};
  let unresolvedPrice = 0;
  let unresolvedAgeTier = 0;
  for (const [buildingKey, def] of Object.entries(buildingEntities)) {
    if (!def || typeof def !== "object" || Array.isArray(def)) continue;
    let baseCost = 0;
    let source = "excluded_upkeep_only"; // construction_demand, or no cost mechanism at all
    if (typeof def.price === "string") {
      const priceEntry = priceByKey[def.price];
      if (priceEntry) {
        baseCost = resolveGold(priceEntry, scriptValues);
        source = "price";
      } else {
        unresolvedPrice++;
        source = "unresolved_price";
      }
    } else {
      const isExpensive = def.expensive === true;
      const gated = isAlwaysNoGated(def.allow) || isAlwaysNoGated(def.country_potential) || isAlwaysNoGated(def.potential);
      const ageKey = ageByBuilding[buildingKey] || (gated ? null : "age_1_traditions");
      if (ageKey) {
        const priceKeyName = (isExpensive ? "p_expensive_building_" : "p_building_") + ageKey;
        const priceEntry = priceByKey[priceKeyName];
        if (priceEntry) {
          baseCost = resolveGold(priceEntry, scriptValues);
          source = "age_tier";
        } else {
          unresolvedAgeTier++;
          source = "unresolved_age_tier";
        }
      }
    }
    const increasePerLevelCost = typeof def.increase_per_level_cost === "number" ? def.increase_per_level_cost : 0;
    costs[buildingKey] = {
      baseCost: Math.round(baseCost * 100000) / 100000,
      increasePerLevelCost,
      category: typeof def.category === "string" ? def.category : null,
      source,
    };
  }

  const priced = Object.values(costs).filter((c) => c.source === "price").length;
  const ageTiered = Object.values(costs).filter((c) => c.source === "age_tier").length;
  return { costs, stats: { buildingTypes: Object.keys(costs).length, priced, ageTiered, unresolvedPrice, unresolvedAgeTier } };
}

function main() {
  const args = process.argv.slice(2);
  const rootArg = args.find((a) => a.startsWith("--root="));
  const root = rootArg ? rootArg.slice("--root=".length) : DEFAULT_GAME_ROOT;

  if (!fs.existsSync(path.join(root, "game", "in_game", "common", "building_types"))) {
    console.error(`Could not find game/in_game/common/building_types under "${root}" - pass --root="C:\\path\\to\\Europa Universalis V"`);
    process.exit(1);
  }

  const { costs, stats } = buildBuildingCosts(root);

  const outDir = path.resolve(__dirname, "..", "game_data");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "building-costs.json");
  fs.writeFileSync(outPath, JSON.stringify(costs));

  console.log(`Wrote ${outPath}`);
  console.log(
    `Building types: ${stats.buildingTypes} (${stats.priced} explicit price, ${stats.ageTiered} age-tier default, rest excluded as unbuildable/upkeep-only)`
  );
  if (stats.unresolvedPrice) console.warn(`  ${stats.unresolvedPrice} building(s) reference a price key not found in prices/*.txt`);
  if (stats.unresolvedAgeTier) console.warn(`  ${stats.unresolvedAgeTier} building(s) reference an age-tier price key not found in prices/*.txt`);
}

if (require.main === module) main();

module.exports = { buildBuildingCosts, DEFAULT_GAME_ROOT };
