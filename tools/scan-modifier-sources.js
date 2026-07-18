// Offline dev tool (not part of the runtime app): finds every place in the
// player's local EU5 install that grants a given modifier key (e.g.
// "selling_efficiency"), so a "which sources do I have vs. am I missing"
// feature can be built against real game data instead of guesswork.
//
// Read-only - never writes into the game install. Output goes to
// game_data/ (gitignored, same treatment as map_data/'s raw Paradox files -
// this is Paradox's own design/balance data, not something to commit).
//
// Usage:
//   node tools/scan-modifier-sources.js <modifier_key> [--root="C:\path\to\Europa Universalis V"]
//
// Reuses js/clausewitz.js's Scanner (the same block parser the save formats
// use) rather than writing a second one - the underlying Clausewitz block
// syntax (key=value, nested {}, arrays) is identical between save files and
// game design files. The one real difference is comments (`# ...`), which
// the save-oriented Scanner never needed to handle - stripped here first,
// same approach tools/build-location-data.js already uses for definitions.txt.
//
// Comparison-operator trigger lines (e.g. "some_value > 5", used inside
// potential/allow/limit blocks) are NOT treated as key=value by the reused
// Scanner - a bare token followed by anything other than "=" just becomes a
// stray positional array item instead of a named key. That's exactly the
// behavior wanted here: this tool only cares about genuine `key = value`
// grants, so trigger-only mentions of a modifier key naturally never show
// up as a false-positive "source".
const fs = require("fs");
const path = require("path");
const cw = require("../js/clausewitz.js");

function stripCommentsAndBom(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // Naive strip (doesn't special-case '#' inside quoted strings) - matches
  // the existing precedent in tools/build-location-data.js; EU5's own game
  // files don't appear to ever put a literal '#' inside a quoted string.
  return text.replace(/#[^\n]*/g, "");
}

function parseEntityFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const text = stripCommentsAndBom(raw);
  const scanner = new cw.Scanner(text, 0, text.length);
  try {
    return scanner.parseBlockBody();
  } catch (err) {
    console.warn(`  [skip: parse error] ${filePath}: ${err.message}`);
    return null;
  }
}

function listFilesRecursive(dir, denylistDirNames) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (denylistDirNames.has(entry.name)) continue;
      out.push(...listFilesRecursive(path.join(dir, entry.name), denylistDirNames));
    } else if (entry.isFile() && entry.name.endsWith(".txt")) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// Folders under common/ that are either not entity-modifier-bearing (pure
// flavor text, AI weights, DNA/genetics, localization keys, tests) or huge
// and irrelevant - skipped to keep the scan fast and low-noise. Everything
// else under common/ is scanned generically.
const DENYLIST_DIRS = new Set([
  "tests",
  "tutorial_lesson_chains",
  "tutorial_lessons",
  "music_player_tracks",
  "scripted_guis",
  "effect_localization",
  "trigger_localization",
  "customizable_localization",
  "avatars",
  "ethnicities",
  "genes",
  "persistent_dna",
  "ai_scripted_expansion_score",
  "ai_scripted_expansion_target",
  "ai_personalities",
  "ai_diplochance",
]);

// Recursively walks a parsed entity-file object tree looking for every
// occurrence of `targetKey` used as a real key=value assignment (not found
// as a bare positional array item, which is what a comparison-operator
// trigger line degrades to - see the file-level comment above).
function findKeyOccurrences(node, targetKey, breadcrumb, out) {
  if (Array.isArray(node)) {
    for (const el of node) findKeyOccurrences(el, targetKey, breadcrumb, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "__items") {
      findKeyOccurrences(value, targetKey, breadcrumb, out);
      continue;
    }
    if (key === targetKey) {
      const values = Array.isArray(value) ? value : [value];
      for (const v of values) {
        // Skip nested-object values (a same-named sub-block, not a grant -
        // vanishingly rare, but real key=value grants are always scalars).
        if (v && typeof v === "object") continue;
        out.push({ path: breadcrumb.slice(), value: v });
      }
    }
    if (value && typeof value === "object") findKeyOccurrences(value, targetKey, [...breadcrumb, key], out);
  }
}

function buildValueResolver(root) {
  const scriptValuesDir = path.join(root, "game", "main_menu", "common", "script_values");
  const resolved = new Map();
  for (const file of listFilesRecursive(scriptValuesDir, new Set())) {
    const parsed = parseEntityFile(file);
    if (!parsed || typeof parsed !== "object") continue;
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number") resolved.set(key, value);
    }
  }
  return resolved;
}

function resolveValue(raw, resolver) {
  if (typeof raw === "number") return { resolved: raw, raw };
  if (typeof raw === "string" && resolver.has(raw)) return { resolved: resolver.get(raw), raw };
  return { resolved: null, raw };
}

function main() {
  const args = process.argv.slice(2);
  const modifierKey = args.find((a) => !a.startsWith("--"));
  const rootArg = args.find((a) => a.startsWith("--root="));
  const root = rootArg ? rootArg.slice("--root=".length) : "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Europa Universalis V";

  if (!modifierKey) {
    console.error("Usage: node tools/scan-modifier-sources.js <modifier_key> [--root=\"C:\\path\\to\\Europa Universalis V\"]");
    process.exit(1);
  }
  if (!fs.existsSync(root)) {
    console.error(`Install not found at: ${root}\nPass --root="C:\\path\\to\\Europa Universalis V" if it's installed elsewhere.`);
    process.exit(1);
  }

  console.log(`Resolving named scripted-value tiers (tiny/small/medium/... bonus tokens)...`);
  const resolver = buildValueResolver(root);
  console.log(`  ${resolver.size} named values resolved.`);

  const commonDir = path.join(root, "game", "in_game", "common");
  const files = listFilesRecursive(commonDir, DENYLIST_DIRS);
  console.log(`Scanning ${files.length} files under game/in_game/common/ for "${modifierKey}"...`);

  const direct = []; // { folder, file, entity, path, resolvedValue, rawValue }
  for (const file of files) {
    const parsed = parseEntityFile(file);
    if (!parsed) continue;
    const hits = [];
    findKeyOccurrences(parsed, modifierKey, [], hits);
    if (!hits.length) continue;
    const relFile = path.relative(commonDir, file);
    const folder = relFile.split(path.sep)[0];
    for (const hit of hits) {
      const { resolved, raw } = resolveValue(hit.value, resolver);
      direct.push({
        folder,
        file: relFile,
        entity: hit.path[0] || "(file-level)",
        path: hit.path,
        rawValue: raw,
        resolvedValue: resolved,
      });
    }
  }

  // Secondary tier: named modifier BUNDLES (static_modifiers/*.txt) that
  // contain this key. These are templates referenced by id from elsewhere
  // (events/missions/decisions/situations via add_country_modifier) rather
  // than granted directly by a player choice - real sources, but one hop
  // removed and not necessarily player-actionable the way researching an
  // advance or enacting a law is. Listed separately, not resolved further
  // in this first pass.
  const staticModifiersDir = path.join(root, "game", "main_menu", "common", "static_modifiers");
  const bundleFiles = listFilesRecursive(staticModifiersDir, new Set());
  const bundles = [];
  for (const file of bundleFiles) {
    const parsed = parseEntityFile(file);
    if (!parsed) continue;
    const hits = [];
    findKeyOccurrences(parsed, modifierKey, [], hits);
    if (!hits.length) continue;
    const relFile = path.relative(staticModifiersDir, file);
    for (const hit of hits) {
      const { resolved, raw } = resolveValue(hit.value, resolver);
      bundles.push({ file: relFile, bundleId: hit.path[0] || "(file-level)", rawValue: raw, resolvedValue: resolved });
    }
  }

  const outDir = path.join(__dirname, "..", "game_data", "modifier-sources");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${modifierKey}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ modifierKey, generatedFrom: root, direct, bundles }, null, 2));

  console.log(`\n=== Direct sources of "${modifierKey}" (${direct.length}) ===`);
  const byFolder = new Map();
  for (const d of direct) {
    if (!byFolder.has(d.folder)) byFolder.set(d.folder, []);
    byFolder.get(d.folder).push(d);
  }
  for (const [folder, items] of [...byFolder.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`\n-- ${folder} (${items.length}) --`);
    for (const item of items) {
      const valueStr = item.resolvedValue !== null ? item.resolvedValue : `${item.rawValue} (unresolved)`;
      console.log(`  ${item.entity.padEnd(40)} ${valueStr}   [${item.path.join(" > ")}]`);
    }
  }

  console.log(`\n=== Indirect (bundle) sources of "${modifierKey}" (${bundles.length}) ===`);
  console.log(`These are named modifier templates granted BY something else (an event/mission/decision/situation) - not resolved further in this pass.`);
  for (const b of bundles) {
    const valueStr = b.resolvedValue !== null ? b.resolvedValue : `${b.rawValue} (unresolved)`;
    console.log(`  ${b.bundleId.padEnd(50)} ${valueStr}`);
  }

  console.log(`\nWrote ${outFile}`);
}

main();
