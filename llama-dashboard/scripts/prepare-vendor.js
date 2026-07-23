#!/usr/bin/env node
"use strict";

// Copies the recorder + scoring engine files this app embeds (see main.js's
// vendorPath()) into ./vendor/ so electron-packager (which just packages a
// plain directory tree, unlike electron-builder's from/to file mappings) has
// something to bundle. Run before `npm run dist` - the dist script does this
// automatically. Not needed for `npm start` (dev mode reads the real files
// in ../js and ../llama-score-automatic-logging-machine directly, so it's
// always current with the latest source).

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const vendorDir = path.join(root, "vendor");

const copies = [
  {
    from: path.join(root, "..", "js"),
    to: path.join(vendorDir, "js"),
    files: ["llama-score.js", "clausewitz.js", "clausewitz-binary.js", "eu5-fixed-ids.js", "modifier-finder.js"],
  },
  { from: path.join(root, "..", "tools"), to: path.join(vendorDir, "tools"), files: ["scan-modifier-sources.js"] },
  {
    from: path.join(root, "..", "llama-score-automatic-logging-machine"),
    to: path.join(vendorDir, "llama-score-automatic-logging-machine"),
    files: ["llama-log-machine.js", "parse-worker.js"],
  },
];

fs.rmSync(vendorDir, { recursive: true, force: true });
for (const { from, to, files } of copies) {
  fs.mkdirSync(to, { recursive: true });
  for (const file of files) {
    fs.copyFileSync(path.join(from, file), path.join(to, file));
  }
}

console.log(`Vendored ${copies.reduce((n, c) => n + c.files.length, 0)} file(s) into ${vendorDir}`);
