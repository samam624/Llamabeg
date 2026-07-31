"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function inventoryDirectory(root) {
  const inventory = new Map();
  if (!fs.existsSync(root)) return inventory;
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile()) {
        const relativePath = path.relative(root, fullPath);
        const bytes = fs.readFileSync(fullPath);
        inventory.set(relativePath, {
          size: bytes.length,
          sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  }
  return inventory;
}

function inventoriesMatch(a, b) {
  if (a.size !== b.size) return false;
  for (const [relativePath, expected] of a) {
    const actual = b.get(relativePath);
    if (!actual || actual.size !== expected.size || actual.sha256 !== expected.sha256) return false;
  }
  return true;
}

function hasFiles(dir) {
  return inventoryDirectory(dir).size > 0;
}

function migrateLegacyData(legacyDir, targetDir, log) {
  const sourceInventory = inventoryDirectory(legacyDir);
  if (!sourceInventory.size) return false;
  if (hasFiles(targetDir)) return false;

  if (fs.existsSync(targetDir)) {
    // Only remove an explicitly verified empty target created by an earlier
    // first-run attempt. Never replace a directory that contains user data.
    if (fs.readdirSync(targetDir).length) return false;
    fs.rmdirSync(targetDir);
  }

  const parentDir = path.dirname(targetDir);
  fs.mkdirSync(parentDir, { recursive: true });
  const stagingDir = `${targetDir}.migrating-${process.pid}-${crypto.randomUUID()}`;
  fs.cpSync(legacyDir, stagingDir, { recursive: true });
  const stagedInventory = inventoryDirectory(stagingDir);
  if (!inventoriesMatch(sourceInventory, stagedInventory)) {
    throw new Error(`Campaign-data migration hash verification failed. The incomplete copy remains at ${stagingDir}`);
  }
  fs.renameSync(stagingDir, targetDir);
  if (log) {
    log(
      `Copied ${sourceInventory.size} legacy campaign-data file(s) to ${targetDir}; the original remains at ${legacyDir} as a backup`
    );
  }
  return true;
}

function resolveDefaultDataDir(options) {
  if (!options.isPackaged) return options.devDataDir;

  const targetDir = path.join(options.documentsDir, "Llamabeg", "Campaign Data");
  const legacyDirs =
    Array.isArray(options.legacyDirs) && options.legacyDirs.length
      ? options.legacyDirs
      : [path.join(path.dirname(options.execPath), "data")];

  for (const legacyDir of legacyDirs) {
    if (path.resolve(targetDir) === path.resolve(legacyDir)) continue;
    try {
      if (migrateLegacyData(legacyDir, targetDir, options.log)) break;
    } catch (err) {
      if (options.log) options.log(`Campaign-data migration failed: ${err.message}`);
      // Keep using the intact legacy folder for this run. It is safer to
      // delay migration than to start a disconnected empty ledger.
      if (hasFiles(legacyDir)) return legacyDir;
      throw err;
    }
  }
  fs.mkdirSync(targetDir, { recursive: true });
  return targetDir;
}

module.exports = {
  inventoryDirectory,
  inventoriesMatch,
  migrateLegacyData,
  resolveDefaultDataDir,
};
