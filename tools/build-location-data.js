// One-off data-prep script (not part of the runtime app): combines the
// user's local copy of the game's map_data/ files into a single compact
// locations.json the web app can load - id -> {name, color}.
//
// Location IDs aren't listed explicitly anywhere in the game files; they're
// assigned by file order when definitions.txt's nested continent/region/
// area/province tree is flattened to its leaf location names (1-based).
// Confirmed against a real save: Sweden's capital field is 1, and location
// #1 in this ordering is "stockholm" - Sweden's real capital.
const fs = require("fs");
const path = require("path");
const cw = require("../js/clausewitz.js");

const MAP_DATA = path.join(__dirname, "..", "map_data");

let defsText = fs.readFileSync(path.join(MAP_DATA, "definitions.txt"), "utf8");
if (defsText.charCodeAt(0) === 0xfeff) defsText = defsText.slice(1);
// clausewitz.js's Scanner has no comment handling (save files never have
// comments) - this is a game data file, which does. Strip them first.
defsText = defsText.replace(/#[^\n]*/g, "");
const scanner = new cw.Scanner(defsText, 0, defsText.length);
const tree = scanner.parseBlockBody();

// A leaf list's immediate parent key is always its enclosing "..._province"
// name by construction (definitions.txt nests continent/region/area/province
// then a bare { location location ... } list) - tracked alongside each name
// so locations.json can record which province each location belongs to. This
// matters because the save's per-location owner field (locations.locations.N.
// owner) can be legitimately blank even when the location is controlled -
// ownership is also tracked one level up, per-province (provinces.database,
// keyed by this same province name via province_definition) - see
// js/map.js's applyProvinceOwnerFallback. Confirmed against a real save:
// verona/venice/vicenza all had blank location-level owners while their
// province-level owner (verona_province etc.) was set correctly.
const orderedNames = [];
const orderedProvinces = [];
(function walk(node, parentKey) {
  if (Array.isArray(node)) {
    for (const el of node) {
      orderedNames.push(el);
      orderedProvinces.push(parentKey);
    }
    return;
  }
  if (node && typeof node === "object") {
    for (const k of Object.keys(node)) walk(node[k], k);
  }
})(tree, null);

const colorLines = fs
  .readFileSync(path.join(MAP_DATA, "named_locations", "00_default.txt"), "utf8")
  .replace(/^﻿/, "")
  .split("\n");
const nameToColor = {};
for (const line of colorLines) {
  // Trailing "#comment" text (e.g. "brandenburg = 88c5f1 #Brandenburg an
  // der Havel") is common here - strip it before matching, not just
  // whole-line comments.
  const t = line.replace(/#.*$/, "").trim();
  if (!t) continue;
  const m = t.match(/^(\S+)\s*=\s*([0-9a-fA-F]+)$/);
  if (m) nameToColor[m[1]] = m[2].padStart(6, "0");
}

let mapText = fs.readFileSync(path.join(MAP_DATA, "default.map"), "utf8");
if (mapText.charCodeAt(0) === 0xfeff) mapText = mapText.slice(1);
mapText = mapText.replace(/#[^\n]*/g, "");
const mapTree = new cw.Scanner(mapText, 0, mapText.length).parseBlockBody();
const seaNames = new Set(mapTree.sea_zones || []);
const lakeNames = new Set(mapTree.lakes || []);

const locations = {};
let withColor = 0;
let seaCount = 0,
  lakeCount = 0;
for (let i = 0; i < orderedNames.length; i++) {
  const id = i + 1;
  const name = orderedNames[i];
  const color = nameToColor[name];
  if (color) withColor++;
  let type = "land";
  if (seaNames.has(name)) {
    type = "sea";
    seaCount++;
  } else if (lakeNames.has(name)) {
    type = "lake";
    lakeCount++;
  }
  locations[id] = { name, color: color || null, type, province: orderedProvinces[i] };
}

console.log(`Total locations: ${orderedNames.length}, with a color entry: ${withColor}`);
console.log(`Water: ${seaCount} sea, ${lakeCount} lake, ${orderedNames.length - seaCount - lakeCount} land`);

fs.writeFileSync(path.join(MAP_DATA, "locations.json"), JSON.stringify(locations));
console.log("Wrote map_data/locations.json");
