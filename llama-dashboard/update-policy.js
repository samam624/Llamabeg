"use strict";

const fs = require("fs");
const path = require("path");

// Installed builds read signed Squirrel release assets from the public source
// repository. The release workflow uploads binaries only; settings, saves, and
// ledger data remain outside both the repository and packaged artifacts.
const UPDATE_REPOSITORY = "samam624/Llamabeg";
const SQUIRREL_FIRST_RUN_DELAY_MS = 10_000;

function squirrelUpdateExe(execPath) {
  return path.resolve(path.dirname(execPath), "..", "Update.exe");
}

function updateEligibility(options) {
  if (options.handlingSquirrelEvent) return { enabled: false, reason: "Squirrel is processing an install/update event" };
  if (!options.isPackaged) return { enabled: false, reason: "development build" };
  if (options.platform !== "win32") return { enabled: false, reason: `unsupported platform ${options.platform}` };

  const updateExe = squirrelUpdateExe(options.execPath);
  const existsSync = options.existsSync || fs.existsSync;
  if (!existsSync(updateExe)) {
    return { enabled: false, reason: "portable build (install with Setup.exe to receive updates)", updateExe };
  }

  return {
    enabled: true,
    reason: "installed Squirrel build",
    updateExe,
    delayMs: (options.argv || []).includes("--squirrel-firstrun") ? SQUIRREL_FIRST_RUN_DELAY_MS : 0,
  };
}

module.exports = {
  UPDATE_REPOSITORY,
  SQUIRREL_FIRST_RUN_DELAY_MS,
  squirrelUpdateExe,
  updateEligibility,
};
