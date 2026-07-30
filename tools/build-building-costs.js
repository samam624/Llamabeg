// Builds game_data/building-costs.json: a static per-building-type base cost
// table (in ducats), so the website can compute a "buildings value" economic
// metric per country from a save's own building_manager records
// (js/clausewitz.js's/clausewitz-binary.js's extractBuildingFields - just
// {type, level, location, owner, ...}, no cost of any kind stored in the
// save itself - confirmed by dumping raw building records directly).
//
// There is NO single flat "cost" field per building type in the game files,
// and only ONE of the two candidate mechanisms found actually represents a
// one-time ducat cost (confirmed with the user, who plays the game - the
// other looked plausible from the files alone but is a real trap):
//   - `building_types/*.txt`'s `price = <name>` - a small set of mostly
//     special/estate/event/unique buildings (~20 of them) that reference a
//     NAMED entry in `prices/*.txt`, giving flat currency amounts (gold,
//     but also religious_influence/stability/legitimacy/etc. for a few
//     non-economic ones - only the `gold` component counts toward a ducat
//     value here). A referenced amount can itself be a scripted value name
//     (e.g. `gold = build_price_age_of_tradition`) needing one more lookup
//     into `script_values/default_values.txt`.
//   - `building_types/*.txt`'s `construction_demand = <name>` (a named
//     `goods_demand/*.txt` goods basket) is NOT a one-time construction
//     cost despite the filename (`goods_demand/building_construction_costs.txt`)
//     and the `category = building_construction` tag on every entry - it's
//     a MONTHLY UPKEEP rate. Confirmed by the user: you don't pay goods as
//     the actual purchase price. (The math even looked wrong before this
//     correction: a temple's recipe priced out to ~1.35 ducats total,
//     absurdly cheap for a real building next to `cathedral`'s 400 flat
//     gold - multiplying by build_time to explain the gap was the wrong fix;
//     the right fix is that this number was never a purchase price at all.)
//     These ~427 ordinary buildings (workshops, temples, guild halls -
//     the bulk of what most nations build) are therefore EXCLUDED from this
//     value table entirely (baseCost 0, source "excluded_upkeep_only") -
//     there is no discoverable one-time ducat cost for them in the game
//     files, so counting them at all would just be a guess. This makes
//     "buildings value" a narrower metric than "every building a nation
//     owns" - only nations holding priced special buildings (cathedrals,
//     hippodromes, estate buildings, ...) show a nonzero value. That's a
//     real, known scope limit, not a bug - see docs/ARCHITECTURE.md.
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

function buildBuildingCosts(root) {
  const priceByKey = parseAllEntitiesInDir(path.join(root, "game", "in_game", "common", "prices"));
  const scriptValues = parseScriptValues(path.join(root, "game", "main_menu", "common", "script_values", "default_values.txt"));
  const buildingEntities = parseAllEntitiesInDir(path.join(root, "game", "in_game", "common", "building_types"));

  const costs = {};
  let unresolvedPrice = 0;
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
  return { costs, stats: { buildingTypes: Object.keys(costs).length, priced, unresolvedPrice } };
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
  console.log(`Building types: ${stats.buildingTypes} (${stats.priced} priced, rest excluded as upkeep-only/free)`);
  if (stats.unresolvedPrice) console.warn(`  ${stats.unresolvedPrice} building(s) reference a price key not found in prices/*.txt`);
}

if (require.main === module) main();

module.exports = { buildBuildingCosts, DEFAULT_GAME_ROOT };
