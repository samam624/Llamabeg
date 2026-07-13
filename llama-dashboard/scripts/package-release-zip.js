#!/usr/bin/env node
"use strict";

// Turns the electron-packager output (npm run dist) into the .zip actually
// handed out from the website's download link (index.html's hardcoded
// GitHub Releases URL). This exists because that zip used to be produced by
// hand - run dist, rename the output folder, zip it, upload it - and that
// manual rename step is exactly what once introduced a trailing space into
// the folder's name (confirmed real-world case: every person who unzipped
// that release got a folder Windows Explorer could see but could never
// delete, because Win32's own path-canonicalization APIs silently strip a
// trailing space before doing a filesystem lookup, while NTFS keeps the
// literal name - so a plain rename/zip round-trip only needs one stray
// keystroke to bake in a name that's unfixable without the `\\?\`
// long-path-prefix trick). Using archiver's `directory(src, destName)` sets
// the zip's internal top-level folder name programmatically instead of
// renaming anything on disk first, so there's no rename step left for a
// typo to hide in - the exact string below is the only place this name is
// ever written, and it's checked at the end of this script too.

const fs = require("fs");
const path = require("path");
const archiver = require("archiver");

const PACKAGED_DIR_NAME = "Llama Score Dashboard-win32-x64"; // electron-packager's own naming (productName has spaces)
const RELEASE_FOLDER_NAME = "Llama-Score-Dashboard-win32-x64"; // what ends up inside the zip, and its filename

const root = path.join(__dirname, "..");
const sourceDir = path.join(root, "release", PACKAGED_DIR_NAME);
const zipPath = path.join(root, "release", `${RELEASE_FOLDER_NAME}.zip`);

if (RELEASE_FOLDER_NAME !== RELEASE_FOLDER_NAME.trim() || /[. ]$/.test(RELEASE_FOLDER_NAME)) {
  throw new Error(`RELEASE_FOLDER_NAME has a trailing space/dot - refusing to build a zip that reproduces the original bug: ${JSON.stringify(RELEASE_FOLDER_NAME)}`);
}

if (!fs.existsSync(sourceDir)) {
  console.error(`Packaged app not found at ${sourceDir} - run "npm run dist" first.`);
  process.exit(1);
}

const output = fs.createWriteStream(zipPath);
const archive = archiver("zip", { zlib: { level: 9 } });

output.on("close", () => {
  console.log(`Wrote ${zipPath} (${archive.pointer()} bytes)`);
  console.log(`Internal top-level folder name: ${JSON.stringify(RELEASE_FOLDER_NAME)} (length ${RELEASE_FOLDER_NAME.length}, last char code ${RELEASE_FOLDER_NAME.charCodeAt(RELEASE_FOLDER_NAME.length - 1)})`);
});
archive.on("warning", (err) => {
  throw err;
});
archive.on("error", (err) => {
  throw err;
});

archive.pipe(output);
archive.directory(sourceDir, RELEASE_FOLDER_NAME);
archive.finalize();
