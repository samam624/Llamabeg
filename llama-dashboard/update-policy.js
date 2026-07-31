"use strict";

const fs = require("fs");
const path = require("path");

// Installed builds read signed Squirrel release assets from the public source
// repository. The release workflow uploads binaries only; settings, saves, and
// ledger data remain outside both the repository and packaged artifacts.
const UPDATE_REPOSITORY = "samam624/Llamabeg";
const RELEASE_API_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
const RELEASE_PAGE_URL = `https://github.com/${UPDATE_REPOSITORY}/releases/latest`;
const SQUIRREL_FIRST_RUN_DELAY_MS = 10_000;
const UPDATE_INTERVAL_MS = 60 * 60 * 1000;

function squirrelUpdateExe(execPath) {
  return path.resolve(path.dirname(execPath), "..", "Update.exe");
}

function updateEligibility(options) {
  if (options.handlingSquirrelEvent) return { enabled: false, reason: "Squirrel is processing an install/update event" };
  if (!options.isPackaged) return { enabled: false, reason: "development build" };
  if (options.platform === "darwin") {
    return {
      enabled: true,
      mode: "manual",
      reason: "macOS release notification (automatic replacement requires Apple code signing)",
      delayMs: 0,
    };
  }
  if (options.platform === "linux") {
    return {
      enabled: true,
      mode: "manual",
      reason: "Linux release notification (install updates with the downloaded package)",
      delayMs: 0,
    };
  }
  if (options.platform !== "win32") return { enabled: false, reason: `unsupported platform ${options.platform}` };

  const updateExe = squirrelUpdateExe(options.execPath);
  const existsSync = options.existsSync || fs.existsSync;
  if (!existsSync(updateExe)) {
    return { enabled: false, reason: "portable build (install with Setup.exe to receive updates)", updateExe };
  }

  return {
    enabled: true,
    mode: "automatic",
    reason: "installed Squirrel build",
    updateExe,
    delayMs: (options.argv || []).includes("--squirrel-firstrun") ? SQUIRREL_FIRST_RUN_DELAY_MS : 0,
  };
}

function numericVersion(value) {
  const match = String(value || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1).map(Number) : null;
}

function isNewerVersion(currentVersion, candidateVersion) {
  const current = numericVersion(currentVersion);
  const candidate = numericVersion(candidateVersion);
  if (!current || !candidate) return false;
  for (let index = 0; index < current.length; index += 1) {
    if (candidate[index] !== current[index]) return candidate[index] > current[index];
  }
  return false;
}

module.exports = {
  UPDATE_REPOSITORY,
  RELEASE_API_URL,
  RELEASE_PAGE_URL,
  SQUIRREL_FIRST_RUN_DELAY_MS,
  UPDATE_INTERVAL_MS,
  squirrelUpdateExe,
  updateEligibility,
  isNewerVersion,
};
