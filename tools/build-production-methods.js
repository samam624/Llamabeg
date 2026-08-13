#!/usr/bin/env node
"use strict";

// Builds the compact, derived game-data table used to estimate the green
// "Production Efficiency" modifier shown on an EU5 building. Saves retain
// the selected production-method key, building levels, market data, and
// normalized last month's profit, but not that already-computed percentage.
// The website combines those save fields with these input/output coefficients.
//
// Usage: node tools/build-production-methods.js [--root="C:\path\to\Europa Universalis V"]
// Output: game_data/production-methods.json (derived numbers only; the
// gitignored game_data directory is copied into deployment builds explicitly).

const fs = require("fs");
const path = require("path");
const cw = require("../js/clausewitz.js");

const DEFAULT_GAME_ROOT = "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Europa Universalis V";

function stripCommentsAndBom(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/#[^\n]*/g, "");
}

function parseEntitiesInFile(filePath) {
  const text = stripCommentsAndBom(fs.readFileSync(filePath, "utf8"));
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
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".txt"));
  } catch {
    return out;
  }
  for (const name of files) Object.assign(out, parseEntitiesInFile(path.join(dir, name)));
  return out;
}

function parseFlatScriptValues(dir) {
  const values = {};
  const entities = parseAllEntitiesInDir(dir);
  for (const [key, value] of Object.entries(entities)) {
    if (typeof value === "number" && Number.isFinite(value)) values[key] = value;
  }
  return values;
}

function resolveNumber(value, scriptValues) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && typeof scriptValues[value] === "number") return scriptValues[value];
  return null;
}

function methodRecord(def, goods, scriptValues) {
  if (!def || typeof def !== "object" || Array.isArray(def) || typeof def.produced !== "string") return null;
  const output = resolveNumber(def.output, scriptValues);
  if (!(output > 0)) return null;
  const inputs = {};
  for (const [key, value] of Object.entries(def)) {
    if (!goods.has(key)) continue;
    const amount = resolveNumber(value, scriptValues);
    if (amount > 0) inputs[key] = amount;
  }
  return { produced: def.produced, output, inputs };
}

function buildProductionMethods(root) {
  const common = path.join(root, "game", "in_game", "common");
  const scriptValues = {
    ...parseFlatScriptValues(path.join(root, "game", "main_menu", "common", "script_values")),
    ...parseFlatScriptValues(path.join(common, "script_values")),
  };
  const goods = new Set(Object.keys(parseAllEntitiesInDir(path.join(common, "goods"))));
  const buildingsRaw = parseAllEntitiesInDir(path.join(common, "building_types"));
  const methodsRaw = parseAllEntitiesInDir(path.join(common, "production_methods"));

  // Unique methods are declared inline on their building type but serialize
  // under exactly the same dynamic method key as shared methods.
  for (const def of Object.values(buildingsRaw)) {
    if (!def || typeof def !== "object" || Array.isArray(def)) continue;
    const unique = def.unique_production_methods;
    if (!unique || typeof unique !== "object" || Array.isArray(unique)) continue;
    for (const [key, method] of Object.entries(unique)) methodsRaw[key] = method;
  }

  const methods = {};
  for (const [key, def] of Object.entries(methodsRaw)) {
    const record = methodRecord(def, goods, scriptValues);
    if (record) methods[key] = record;
  }

  const buildings = {};
  let unresolvedEmployment = 0;
  for (const [key, def] of Object.entries(buildingsRaw)) {
    if (!def || typeof def !== "object" || Array.isArray(def)) continue;
    const employmentSize = resolveNumber(def.employment_size, scriptValues);
    if (def.employment_size !== undefined && employmentSize === null) unresolvedEmployment++;
    buildings[key] = { employmentSize };
  }

  return {
    data: { version: 1, buildings, methods },
    stats: {
      buildings: Object.keys(buildings).length,
      methods: Object.keys(methods).length,
      goods: goods.size,
      unresolvedEmployment,
    },
  };
}

function main() {
  const rootArg = process.argv.slice(2).find((arg) => arg.startsWith("--root="));
  const root = rootArg ? rootArg.slice("--root=".length) : DEFAULT_GAME_ROOT;
  const required = path.join(root, "game", "in_game", "common", "production_methods");
  if (!fs.existsSync(required)) {
    console.error(`Could not find game/in_game/common/production_methods under "${root}"`);
    process.exit(1);
  }
  const { data, stats } = buildProductionMethods(root);
  const outDir = path.resolve(__dirname, "..", "game_data");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "production-methods.json");
  fs.writeFileSync(outPath, JSON.stringify(data));
  console.log(`Wrote ${outPath}`);
  console.log(`Production methods: ${stats.methods}; building types: ${stats.buildings}; goods: ${stats.goods}`);
  if (stats.unresolvedEmployment) console.warn(`  ${stats.unresolvedEmployment} building employment sizes could not be resolved`);
}

if (require.main === module) main();

module.exports = { buildProductionMethods, DEFAULT_GAME_ROOT };
