#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "dist");

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(srcPath, destPath);
    else if (entry.isFile()) fs.copyFileSync(srcPath, destPath);
  }
}

function copyFile(relativePath) {
  const src = path.join(root, relativePath);
  const dest = path.join(outDir, relativePath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

copyFile("index.html");
copyDir(path.join(root, "css"), path.join(outDir, "css"));
copyDir(path.join(root, "js"), path.join(outDir, "js"));
copyDir(path.join(root, "assets"), path.join(outDir, "assets"));

// Only the two DERIVED, data-only map files ship - never Paradox's original
// locations.png artwork / definitions.txt / named_locations (see
// map_data/README.md and docs/ARCHITECTURE.md's "Map" section for why that
// distinction matters). Both are optional locally (see root README's "Map
// setup") - a contributor's checkout without them still builds fine, just
// without the Map tab/Home backdrop working.
const MAP_DATA_FILES = ["location_ids.png", "locations.json"];
let mapDataShipped = 0;
for (const name of MAP_DATA_FILES) {
  const src = path.join(root, "map_data", name);
  if (fs.existsSync(src)) {
    copyFile(path.join("map_data", name));
    mapDataShipped++;
  }
}
if (mapDataShipped < MAP_DATA_FILES.length) {
  console.warn(`map_data/ not fully set up locally (${mapDataShipped}/${MAP_DATA_FILES.length} files found) - Map tab/Home backdrop won't work in this build. See root README's "Map setup".`);
}

console.log(`Built static site in ${path.relative(root, outDir)}`);
