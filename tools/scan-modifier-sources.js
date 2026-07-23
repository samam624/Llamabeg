// Shared read-only scanner (CLI + desktop Modifier Optimizer): finds every
// place in the player's local EU5 install that grants a given modifier key
// (e.g. "selling_efficiency"), so active/missing-source analysis is built
// against real game data instead of guesswork.
//
// Read-only with respect to the game install. The CLI writes its derived
// JSON to game_data/ (gitignored); the desktop calls the exported function
// and keeps the result in memory.
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

const englishLocalizationCache = new Map();

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

function listFilesRecursive(dir, denylistDirNames, extensions = new Set([".txt"])) {
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
      out.push(...listFilesRecursive(path.join(dir, entry.name), denylistDirNames, extensions));
    } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function prettifyId(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

// EU5 spreads estate-privilege names across the main estate localization
// file and several country/event files. Build one cached English index for
// the installed game rather than guessing a display name from the raw id.
function buildEnglishLocalization(root) {
  let cached = englishLocalizationCache.get(root);
  if (cached) return cached;

  const localization = {};
  const dir = path.join(root, "game", "main_menu", "localization", "english");
  for (const file of listFilesRecursive(dir, new Set(), new Set([".yml"]))) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([^\s:#]+):(?:\d+)?\s+"(.*)"\s*$/);
      if (!match) continue;
      localization[match[1]] = match[2].replace(/\\n/g, " ").replace(/\\"/g, '"');
    }
  }
  englishLocalizationCache.set(root, localization);
  return localization;
}

function localizedText(id, localization, depth = 0) {
  if (!id) return null;
  if (depth > 5) return prettifyId(id);
  let text = localization[id] || prettifyId(id);
  text = text.replace(/\$([a-zA-Z0-9_.-]+)\$/g, (_match, nestedId) => localizedText(nestedId, localization, depth + 1));
  text = text.replace(/\[([^\]]*?)'([^']+)'([^\]]*?)\]/g, (_match, before, target, after) => {
    const adjective = /Adjective/i.test(before + after);
    const localized = adjective ? localization[`${target}_ADJ`] || localization[target] : localization[target];
    return localized ? localizedText(adjective && localization[`${target}_ADJ`] ? `${target}_ADJ` : target, localization, depth + 1) : prettifyId(target);
  });
  return text;
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
        out.push({
          path: breadcrumb.slice(),
          value: v,
          // Repeated country_modifier blocks commonly split a law into a
          // leader-only and member-only version. Preserve the condition on
          // the exact block containing this grant so the optimizer does not
          // add both at once.
          impactPotential: node.potential_trigger && typeof node.potential_trigger === "object" ? node.potential_trigger : null,
        });
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

function objectDefinitions(value) {
  if (Array.isArray(value)) return value.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry));
  return value && typeof value === "object" ? [value] : [];
}

function matchingDefinition(parsed, hit, modifierKey) {
  const entity = hit.path[0];
  for (const definition of objectDefinitions(parsed && parsed[entity])) {
    const localHits = [];
    findKeyOccurrences(definition, modifierKey, [entity], localHits);
    if (localHits.some((candidate) => candidate.value === hit.value && candidate.path.join("\0") === hit.path.join("\0"))) return definition;
  }
  return null;
}

function normalizedStringList(value) {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function firstScalarForKey(node, targetKey) {
  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = firstScalarForKey(entry, targetKey);
      if (found !== null) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  for (const [key, value] of Object.entries(node)) {
    if (key === targetKey && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) return value;
    const found = firstScalarForKey(value, targetKey);
    if (found !== null) return found;
  }
  return null;
}

function addBooleanModifierProviders(index, folder, entity, group, choice, countryModifier) {
  if (!countryModifier || typeof countryModifier !== "object" || Array.isArray(countryModifier)) return;
  for (const [modifier, value] of Object.entries(countryModifier)) {
    if (value !== true) continue;
    if (!index[modifier]) index[modifier] = [];
    index[modifier].push({ folder, entity, group: group || null, choice: choice || entity });
  }
}

function indexBooleanModifierSources(index, folder, parsed) {
  if (!["advances", "estate_privileges", "government_reforms", "laws"].includes(folder) || !parsed || typeof parsed !== "object") return;
  for (const [entity, rawDefinition] of Object.entries(parsed)) {
    if (entity === "__items") continue;
    for (const definition of objectDefinitions(rawDefinition)) {
      addBooleanModifierProviders(index, folder, entity, null, entity, definition.country_modifier);
      if (folder !== "laws") continue;
      for (const [choice, choiceDefinition] of Object.entries(definition)) {
        if (!choiceDefinition || typeof choiceDefinition !== "object" || Array.isArray(choiceDefinition)) continue;
        addBooleanModifierProviders(index, folder, entity, entity, choice, choiceDefinition.country_modifier);
      }
    }
  }
}

// Every Hellenism omen's own `potential` is just `{ has_dlc = "d008_fate_of_
// the_phoenix" }` - completely redundant with the religion check already
// modeled explicitly (godReligion, below): a country cannot HAVE hellenism_
// religion as its primary religion without already owning that DLC, so
// reaching this point already proves it. DLC ownership itself isn't tracked
// from the save at all (a real, separate gap - see docs/MODIFIER_OPTIMIZER_
// ROADMAP.md's "DLC ... flags" remaining item), so leaving a bare has_dlc
// node in place would make every single omen show as "needs more data"
// forever, even though this specific case is fully provable another way.
// Scoped to the "gods" folder only - a has_dlc check anywhere else in the
// game (a law, mission, etc. with no equivalent already-proven prerequisite)
// is left completely alone and still correctly reported as unknown.
function stripImpliedDlcCheck(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return node;
  const { has_dlc, ...rest } = node;
  return rest;
}

function compactEligibility(folder, definition, hitPath) {
  if (!definition) return null;
  const choiceId = folder === "laws" ? hitPath[1] : null;
  const choice = choiceId && definition[choiceId] && typeof definition[choiceId] === "object" ? definition[choiceId] : null;
  // A god's omens live under god.omens.<omen_id> (path = [god, "omens", omen_id, ...]) -
  // same "definition -> named sub-block" shape as a law's choices, just one
  // level deeper and under a literal "omens" key instead of the choice ID
  // directly on the definition.
  const omenId = folder === "gods" && hitPath[1] === "omens" ? hitPath[2] : null;
  const omen = omenId && definition.omens && typeof definition.omens === "object" ? definition.omens[omenId] : null;
  let potential = [definition.potential, choice && choice.potential, omen && omen.potential].filter((value) => value && typeof value === "object");
  let allow = [definition.allow, choice && choice.allow, omen && omen.allow].filter((value) => value && typeof value === "object");
  if (folder === "gods") {
    potential = potential.map(stripImpliedDlcCheck);
    allow = allow.map(stripImpliedDlcCheck);
  }
  return {
    age: (choice && choice.age) || definition.age || null,
    requires: normalizedStringList((choice && choice.requires) || definition.requires),
    potential,
    allow,
    estate: definition.estate || null,
    lawCategory: folder === "laws" && typeof definition.law_category === "string" ? definition.law_category : null,
    organizationType: firstScalarForKey(potential, "international_organization_type"),
    // A god's religion requirement isn't a potential/allow trigger - it's
    // implicit metadata (religion.religion on the god definition) EU5 itself
    // enforces by only ever showing your own religion's pantheon. Modeled as
    // an explicit check in evaluateEligibility() rather than folded into the
    // generic trigger evaluator, since it isn't a real game trigger key.
    godReligion: folder === "gods" && definition.religion && typeof definition.religion === "object" && typeof definition.religion.religion === "string" ? definition.religion.religion : null,
  };
}

function compactEstatePrivilegeMetadata(folder, definition, resolver, localization) {
  if (folder !== "estate_privileges" || !definition || typeof definition.estate !== "string") return null;
  const estate = definition.estate;
  const costKey = `global_${estate}_power`;
  const rawCost = firstScalarForKey(definition.country_modifier, costKey);
  const cost = rawCost === null ? { resolved: null, raw: null } : resolveValue(rawCost, resolver);
  return {
    estate,
    estateLabel: localizedText(estate, localization),
    estatePowerCost: cost.resolved,
    rawEstatePowerCost: cost.raw,
  };
}

function compactAutomaticFormula(folder, definition) {
  if (folder !== "auto_modifiers" || !definition) return null;
  return {
    potentialTrigger: definition.potential_trigger && typeof definition.potential_trigger === "object" ? definition.potential_trigger : null,
    scalesWith: definition.scales_with && typeof definition.scales_with === "object" ? definition.scales_with : null,
  };
}

function addUnlock(index, kind, target, advance) {
  for (const id of normalizedStringList(target)) {
    if (!index[kind][id]) index[kind][id] = [];
    if (!index[kind][id].includes(advance)) index[kind][id].push(advance);
  }
}

function indexAdvanceUnlocks(index, parsed) {
  if (!parsed || typeof parsed !== "object") return;
  for (const [advance, rawDefinition] of Object.entries(parsed)) {
    if (advance === "__items") continue;
    for (const definition of objectDefinitions(rawDefinition)) {
      addUnlock(index, "law", definition.unlock_law, advance);
      addUnlock(index, "policy", definition.unlock_policy, advance);
      addUnlock(index, "governmentReform", definition.unlock_government_reform, advance);
      addUnlock(index, "estatePrivilege", definition.unlock_estate_privilege, advance);
    }
  }
}

function buildAgeYears(commonDir) {
  const out = {};
  for (const file of listFilesRecursive(path.join(commonDir, "age"), new Set())) {
    const parsed = parseEntityFile(file);
    if (!parsed || typeof parsed !== "object") continue;
    for (const [id, definition] of Object.entries(parsed)) {
      if (definition && typeof definition.year === "number") out[id] = definition.year;
    }
  }
  return out;
}

function buildCultureIndex(commonDir) {
  const out = {};
  for (const file of listFilesRecursive(path.join(commonDir, "cultures"), new Set())) {
    const parsed = parseEntityFile(file);
    if (!parsed || typeof parsed !== "object") continue;
    for (const [id, rawDefinition] of Object.entries(parsed)) {
      const definition = objectDefinitions(rawDefinition)[0];
      if (!definition) continue;
      out[id] = {
        language: typeof definition.language === "string" ? definition.language : null,
        groups: normalizedStringList(definition.culture_groups),
      };
    }
  }
  return out;
}

const MODIFIER_GRANT_EFFECTS = new Set([
  "add_country_modifier",
  "add_international_organization_modifier",
  "add_province_modifier",
  "add_location_modifier",
]);

function grantDuration(block) {
  for (const unit of ["days", "months", "years"]) {
    if (typeof block[unit] === "number") return { unit, value: block[unit] };
  }
  return null;
}

function collectBundleGrants(node, bundleIds, source, breadcrumb, out) {
  if (Array.isArray(node)) {
    for (const entry of node) collectBundleGrants(entry, bundleIds, source, breadcrumb, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (MODIFIER_GRANT_EFFECTS.has(key)) {
      for (const block of objectDefinitions(value)) {
        if (typeof block.modifier !== "string" || !bundleIds.has(block.modifier)) continue;
        out.push({
          bundleId: block.modifier,
          category: source.category,
          file: source.file,
          entity: breadcrumb[0] || "(file-level)",
          effect: key,
          duration: grantDuration(block),
        });
      }
    }
    if (value && typeof value === "object") collectBundleGrants(value, bundleIds, source, [...breadcrumb, key], out);
  }
}

function commonGrantCategory(relFile) {
  const folder = relFile.split(path.sep)[0];
  if (folder === "missions") return "missions";
  if (folder === "decisions") return "decisions";
  if (["disasters", "situations"].includes(folder)) return "situations";
  if (["generic_actions", "cabinet_actions", "government_actions"].includes(folder)) return "actions";
  return "scripted";
}

function traceBundleGrantors(root, commonDir, commonFiles, bundleIds) {
  const grants = [];
  const eventsDir = path.join(root, "game", "in_game", "events");
  for (const file of listFilesRecursive(eventsDir, new Set())) {
    const parsed = parseEntityFile(file);
    if (parsed) collectBundleGrants(parsed, bundleIds, { category: "events", file: path.relative(eventsDir, file) }, [], grants);
  }
  for (const file of commonFiles) {
    const parsed = parseEntityFile(file);
    if (!parsed) continue;
    const relFile = path.relative(commonDir, file);
    collectBundleGrants(parsed, bundleIds, { category: commonGrantCategory(relFile), file: relFile }, [], grants);
  }

  const seen = new Set();
  const byBundle = new Map();
  for (const grant of grants) {
    const durationKey = grant.duration ? `${grant.duration.value}:${grant.duration.unit}` : "none";
    const key = `${grant.bundleId}\0${grant.category}\0${grant.file}\0${grant.entity}\0${grant.effect}\0${durationKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!byBundle.has(grant.bundleId)) byBundle.set(grant.bundleId, []);
    byBundle.get(grant.bundleId).push(grant);
  }
  return byBundle;
}

const DEFAULT_GAME_ROOT = "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Europa Universalis V";

// Resolves a `$SOME_KEY$` loc self-reference (e.g. army_logistics_distance_modifier
// just points back at army_logistics_distance's own name) to its final display
// text. Depth-guarded since these can theoretically chain.
function resolveModifierLabel(rawLabels, key, depth) {
  const raw = rawLabels.get(key);
  if (raw == null) return null;
  const ref = depth < 6 ? /^\$([A-Za-z0-9_]+)\$$/.exec(raw.trim()) : null;
  if (ref) {
    const refKey = ref[1].replace(/^MODIFIER_TYPE_NAME_/, "");
    const resolved = resolveModifierLabel(rawLabels, refKey, depth + 1);
    if (resolved) return resolved;
  }
  return raw;
}

function titleCaseId(id) {
  return String(id || "")
    .replace(/^game_concept_/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// About 40% of modifier_types_l_english.yml's display names embed Paradox's
// in-tooltip scripted-text syntax (inline concept links, name-lookup function
// calls, icon sprites) rather than plain text, since the real game renders
// these live against other definitions/localization this catalog doesn't
// load. Fully interpreting them would mean loading the entire loc/definition
// graph just to build a search index. Instead, best-effort flatten the
// embedded identifier into a readable phrase - not the exact in-game string,
// but legible and still searchable by the concept it names.
function cleanupModifierLabel(raw) {
  return raw
    .replace(/@[A-Za-z0-9_]+!/g, "") // decorative icon/sprite refs, e.g. @maritime_presence!
    .replace(/\[[A-Za-z]+\('([A-Za-z0-9_]+)'\)(?:\.[A-Za-z]+)?\]/g, (_, id) => titleCaseId(id)) // [ShowXNameWithNoTooltip('id')] / (...).GetNameWithNoTooltip
    .replace(/\[([A-Za-z0-9_]+)\|e\]/g, (_, id) => titleCaseId(id)) // inline concept link [id|e]
    .replace(/\$([A-Za-z0-9_]+)\$/g, (_, id) => titleCaseId(id)) // bare $id$ cross-reference
    .replace(/\[([A-Za-z0-9_]+)\]/g, (_, id) => titleCaseId(id)) // leftover bare [id]
    .replace(/\s+/g, " ")
    .trim();
}

// Builds a search catalog {key, label} for every modifier the game knows a
// display name for, so the desktop UI can offer "Selling Efficiency" instead
// of requiring the user to already know the raw key "selling_efficiency".
// Read once per game install from its own English localization (not scanned
// from 1,600 design files like scanModifierSources) - this is just a lookup
// table of names, not source-tracing.
function scanModifierCatalog(root = DEFAULT_GAME_ROOT) {
  if (!fs.existsSync(root)) throw new Error(`EU5 install not found at: ${root}`);
  const locFile = path.join(root, "game", "main_menu", "localization", "english", "modifier_types_l_english.yml");
  if (!fs.existsSync(locFile)) return [];

  let raw = fs.readFileSync(locFile, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  const rawLabels = new Map();
  const lineRe = /^\s*MODIFIER_TYPE_NAME_(\S+):\d*\s*"(.*)"\s*$/;
  for (const line of raw.split(/\r?\n/)) {
    const match = lineRe.exec(line);
    if (match) rawLabels.set(match[1], match[2]);
  }

  const catalog = [];
  for (const key of rawLabels.keys()) {
    const resolved = resolveModifierLabel(rawLabels, key, 0) || key;
    catalog.push({ key, label: cleanupModifierLabel(resolved) || key });
  }
  catalog.sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  return catalog;
}

function compactModifierImpact(block, resolver) {
  if (!block || typeof block !== "object" || Array.isArray(block)) return [];
  const impacts = [];
  for (const [modifier, rawValue] of Object.entries(block)) {
    if (modifier === "__items" || (typeof rawValue !== "number" && typeof rawValue !== "string")) continue;
    const { resolved, raw } = resolveValue(rawValue, resolver);
    impacts.push({ modifier, rawValue: raw, resolvedValue: resolved });
  }
  return impacts;
}

// Reads the game's own societal-value axis definitions. Directional drift
// keys are mechanical (`monthly_towards_<side>`), while the modifier blocks
// describe the full-strength impact at +/-100 on each side of the axis.
function scanSocietalValueAxes(root = DEFAULT_GAME_ROOT) {
  if (!fs.existsSync(root)) throw new Error(`EU5 install not found at: ${root}`);
  const dir = path.join(root, "game", "in_game", "common", "societal_values");
  const resolver = buildValueResolver(root);
  const axes = [];
  for (const file of listFilesRecursive(dir, new Set())) {
    const parsed = parseEntityFile(file);
    if (!parsed || typeof parsed !== "object") continue;
    for (const [axisKey, rawDefinition] of Object.entries(parsed)) {
      const splitAt = axisKey.indexOf("_vs_");
      const definition = objectDefinitions(rawDefinition)[0];
      if (splitAt < 1 || !definition) continue;
      const leftId = axisKey.slice(0, splitAt);
      const rightId = axisKey.slice(splitAt + 4);
      axes.push({
        axisKey,
        leftId,
        rightId,
        leftModifierKey: `monthly_towards_${leftId}`,
        rightModifierKey: `monthly_towards_${rightId}`,
        leftImpact: compactModifierImpact(definition.left_modifier, resolver),
        rightImpact: compactModifierImpact(definition.right_modifier, resolver),
        file: path.relative(dir, file),
      });
    }
  }
  return axes;
}

// Shared by the CLI below and the desktop app. Keeping the scan itself pure
// (read local game files, return compact JSON) lets Electron consume the same
// result without shelling out or relying on the gitignored game_data cache.
function scanModifierSources(modifierKey, root = DEFAULT_GAME_ROOT, options = {}) {
  if (!/^[a-z0-9_]+$/i.test(String(modifierKey || ""))) throw new Error("Modifier keys may only contain letters, numbers, and underscores.");
  if (!fs.existsSync(root)) throw new Error(`EU5 install not found at: ${root}`);

  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  onProgress("Resolving named scripted-value tiers");
  const resolver = buildValueResolver(root);
  const localization = buildEnglishLocalization(root);

  const commonDir = path.join(root, "game", "in_game", "common");
  const files = listFilesRecursive(commonDir, DENYLIST_DIRS);
  onProgress(`Scanning ${files.length} game definition files`);
  const unlockIndex = { law: {}, policy: {}, governmentReform: {}, estatePrivilege: {} };
  const booleanModifierSources = {};

  const direct = []; // { folder, file, entity, path, resolvedValue, rawValue }
  for (const file of files) {
    const parsed = parseEntityFile(file);
    if (!parsed) continue;
    const relFile = path.relative(commonDir, file);
    const folder = relFile.split(path.sep)[0];
    if (folder === "advances") indexAdvanceUnlocks(unlockIndex, parsed);
    indexBooleanModifierSources(booleanModifierSources, folder, parsed);
    const hits = [];
    findKeyOccurrences(parsed, modifierKey, [], hits);
    if (!hits.length) continue;
    for (const hit of hits) {
      const { resolved, raw } = resolveValue(hit.value, resolver);
      const definition = matchingDefinition(parsed, hit, modifierKey);
      const estatePrivilege = compactEstatePrivilegeMetadata(folder, definition, resolver, localization);
      direct.push(Object.assign({
        folder,
        file: relFile,
        entity: hit.path[0] || "(file-level)",
        displayName: folder === "estate_privileges" ? localizedText(hit.path[0], localization) : null,
        path: hit.path,
        rawValue: raw,
        resolvedValue: resolved,
        eligibility: compactEligibility(folder, definition, hit.path),
        impactPotential: hit.impactPotential,
        automaticFormula: compactAutomaticFormula(folder, definition),
      }, estatePrivilege || {}));
    }
  }

  // Secondary tier: named modifier BUNDLES (static_modifiers/*.txt) that
  // contain this key. These are templates referenced by id from elsewhere
  // (events/missions/decisions/situations via add_country_modifier) rather
  // than granted directly by a player choice - real sources, but one hop
  // removed and not necessarily player-actionable the way researching an
  // advance or enacting a law is. Their grant effects and durations are
  // traced below and kept separate from optimizer candidates.
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

  onProgress(`Tracing ${bundles.length} indirect modifier bundles to events and scripted actions`);
  const bundleGrantors = traceBundleGrantors(root, commonDir, files, new Set(bundles.map((bundle) => bundle.bundleId)));
  for (const bundle of bundles) bundle.grantors = bundleGrantors.get(bundle.bundleId) || [];

  return {
    modifierKey,
    generatedFrom: root,
    direct,
    bundles,
    eligibilityData: {
      ageYears: buildAgeYears(commonDir),
      cultures: buildCultureIndex(commonDir),
      unlockIndex,
      booleanModifierSources,
    },
  };
}

function main() {
  const args = process.argv.slice(2);
  const modifierKey = args.find((a) => !a.startsWith("--"));
  const rootArg = args.find((a) => a.startsWith("--root="));
  const root = rootArg ? rootArg.slice("--root=".length) : DEFAULT_GAME_ROOT;

  if (!modifierKey) {
    console.error("Usage: node tools/scan-modifier-sources.js <modifier_key> [--root=\"C:\\path\\to\\Europa Universalis V\"]");
    process.exit(1);
  }

  let result;
  try {
    result = scanModifierSources(modifierKey, root, { onProgress: (message) => console.log(`${message}...`) });
  } catch (err) {
    console.error(err.message || String(err));
    process.exit(1);
  }
  const { direct, bundles } = result;

  const outDir = path.join(__dirname, "..", "game_data", "modifier-sources");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${modifierKey}.json`);
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));

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
  console.log(`These are named modifier templates, traced to the scripts that grant them when a direct grant exists.`);
  for (const b of bundles) {
    const valueStr = b.resolvedValue !== null ? b.resolvedValue : `${b.rawValue} (unresolved)`;
    const categories = [...new Set((b.grantors || []).map((grantor) => grantor.category))];
    console.log(`  ${b.bundleId.padEnd(50)} ${valueStr}  [${categories.join(", ") || "untraced/static"}]`);
  }

  console.log(`\nWrote ${outFile}`);
}

module.exports = {
  DEFAULT_GAME_ROOT,
  scanModifierSources,
  scanSocietalValueAxes,
  scanModifierCatalog,
  stripCommentsAndBom,
  findKeyOccurrences,
};

if (require.main === module) main();
