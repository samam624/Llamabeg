#!/usr/bin/env node
"use strict";

// Rebuilds the one canonical local dashboard folder without destroying the
// campaign ledger that lives beside its executable. electron-packager's
// `overwrite` option replaces that whole folder, so preserve data outside
// release/ for the duration of the build and restore it in a finally block.

const fs = require("fs");
const os = require("os");
const path = require("path");
const packager = require("electron-packager");

const certificateFile = process.env.WINDOWS_CERTIFICATE_FILE;
const certificatePassword = process.env.WINDOWS_CERTIFICATE_PASSWORD;
if (Boolean(certificateFile) !== Boolean(certificatePassword)) {
  throw new Error("WINDOWS_CERTIFICATE_FILE and WINDOWS_CERTIFICATE_PASSWORD must either both be set or both be omitted.");
}

const root = path.join(__dirname, "..");
const releaseDir = path.join(root, "release");
const packagedDir = path.join(releaseDir, "Llama Score Dashboard-win32-x64");
const dataDir = path.join(packagedDir, "data");
const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llama-dashboard-data-"));
const backupDataDir = path.join(backupRoot, "data");
const hadData = fs.existsSync(dataDir);

if (hadData) {
  try {
    fs.renameSync(dataDir, backupDataDir);
  } catch (err) {
    fs.rmSync(backupRoot, { recursive: true, force: true });
    throw new Error(`Could not preserve the dashboard ledger before packaging. Close the dashboard and try again. ${err.message}`);
  }
}

let packaged = false;
let dataRestored = !hadData;
(async () => {
  try {
    const outputPaths = await packager({
      dir: root,
      name: "Llama Score Dashboard",
      platform: "win32",
      arch: "x64",
      out: releaseDir,
      overwrite: true,
      icon: path.join(root, "assets", "llama-logo.ico"),
      ...(certificateFile
        ? {
            windowsSign: {
              certificateFile,
              certificatePassword,
              hashes: ["sha256"],
              timestampServer: process.env.WINDOWS_TIMESTAMP_URL || "http://timestamp.digicert.com",
              description: "Llama Score Dashboard",
              website: "https://llamabeg.netlify.app",
            },
          }
        : {}),
      ignore: [
        /^\/release(?:\/|$)/,
        /^\/(?!main\.js$|preload\.js$|data-paths\.js$|platform-paths\.js$|update-policy\.js$|renderer(?:\/|$)|package\.json$|vendor(?:\/|$)|assets(?:\/|$)|node_modules(?:\/|$))/,
        /^\/node_modules\/(?!(?:electron-squirrel-startup|update-electron-app|github-url-to-object|is-url|ms)(?:\/|$))/,
      ],
    });
    packaged = true;
    console.log(`Wrote canonical dashboard app to: ${outputPaths[0]}`);
  } finally {
    try {
      fs.mkdirSync(packagedDir, { recursive: true });
      if (hadData) {
        if (fs.existsSync(dataDir)) throw new Error(`Packaging unexpectedly created ${dataDir}; refusing to overwrite the preserved ledger.`);
        fs.renameSync(backupDataDir, dataDir);
        dataRestored = true;
        console.log(`Restored local ledger data to: ${dataDir}`);
      } else if (packaged) {
        fs.mkdirSync(dataDir, { recursive: true });
        console.log(`Created empty local ledger folder: ${dataDir}`);
      }
    } finally {
      if (dataRestored) fs.rmSync(backupRoot, { recursive: true, force: true });
      else console.error(`Ledger restoration failed. The preserved data remains at: ${backupDataDir}`);
    }
  }
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
