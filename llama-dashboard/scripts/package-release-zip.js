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
const os = require("os");
const path = require("path");
const archiver = require("archiver");

const PACKAGED_DIR_NAME = "Llama Score Dashboard-win32-x64"; // electron-packager's own naming (productName has spaces)
const RELEASE_FOLDER_NAME = "Llama-Score-Dashboard-win32-x64"; // what ends up inside the zip, and its filename

const root = path.join(__dirname, "..");
const sourceDir = path.join(root, "release", PACKAGED_DIR_NAME);
const zipPath = path.join(root, "release", `${RELEASE_FOLDER_NAME}.zip`);
const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llama-dashboard-public-release-"));
const stagedAppDir = path.join(stagingRoot, RELEASE_FOLDER_NAME);
const sourceDataDir = path.join(sourceDir, "data");

if (RELEASE_FOLDER_NAME !== RELEASE_FOLDER_NAME.trim() || /[. ]$/.test(RELEASE_FOLDER_NAME)) {
  throw new Error(`RELEASE_FOLDER_NAME has a trailing space/dot - refusing to build a zip that reproduces the original bug: ${JSON.stringify(RELEASE_FOLDER_NAME)}`);
}

if (!fs.existsSync(sourceDir)) {
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  console.error(`Packaged app not found at ${sourceDir} - run "npm run dist" first.`);
  process.exit(1);
}

// Never archive the local recorder ledger. Make a clean staging tree that
// contains the packaged runtime plus an explicitly empty data directory.
// This remains safe even when `npm run package-zip` is invoked directly on a
// canonical app folder that contains real campaign data.
fs.cpSync(sourceDir, stagedAppDir, {
  recursive: true,
  filter(source) {
    const resolved = path.resolve(source);
    const dataRoot = path.resolve(sourceDataDir);
    return resolved !== dataRoot && !resolved.startsWith(`${dataRoot}${path.sep}`);
  },
});
const stagedDataDir = path.join(stagedAppDir, "data");
fs.mkdirSync(stagedDataDir, { recursive: true });
if (fs.readdirSync(stagedDataDir).length) {
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  throw new Error("Public release staging unexpectedly contains ledger data; refusing to create the ZIP.");
}

const output = fs.createWriteStream(zipPath);
const archive = archiver("zip", { zlib: { level: 9 } });

output.on("close", () => {
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  console.log(`Wrote ${zipPath} (${archive.pointer()} bytes)`);
  console.log(`Internal top-level folder name: ${JSON.stringify(RELEASE_FOLDER_NAME)} (length ${RELEASE_FOLDER_NAME.length}, last char code ${RELEASE_FOLDER_NAME.charCodeAt(RELEASE_FOLDER_NAME.length - 1)})`);
  console.log("Verified public data/ folder is empty; no local ledger files were archived.");
});
output.on("error", (err) => {
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  throw err;
});
archive.on("warning", (err) => {
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  throw err;
});
archive.on("error", (err) => {
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  throw err;
});

archive.pipe(output);
archive.directory(stagedAppDir, RELEASE_FOLDER_NAME);
archive.finalize();
