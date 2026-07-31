"use strict";

const fs = require("fs");
const path = require("path");

const EU5_STEAM_APP_ID = "3450310";
const SAVE_PARTS = ["Paradox Interactive", "Europa Universalis V", "save games"];
const GAME_FOLDER = "Europa Universalis V";

function firstExisting(candidates, existsSync = fs.existsSync) {
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

function linuxSteamRoots(homeDir, pathModule = path) {
  return [
    pathModule.join(homeDir, ".local", "share", "Steam"),
    pathModule.join(homeDir, ".steam", "steam"),
    pathModule.join(homeDir, ".var", "app", "com.valvesoftware.Steam", ".local", "share", "Steam"),
  ];
}

function defaultSaveDir(options) {
  const pathModule = options.pathModule || path;
  const standardDocumentsDir = pathModule.join(options.documentsDir, ...SAVE_PARTS);
  if (options.platform !== "linux") return standardDocumentsDir;

  const protonDirs = linuxSteamRoots(options.homeDir, pathModule).map((steamRoot) =>
    pathModule.join(
      steamRoot,
      "steamapps",
      "compatdata",
      EU5_STEAM_APP_ID,
      "pfx",
      "drive_c",
      "users",
      "steamuser",
      "Documents",
      ...SAVE_PARTS
    )
  );
  const nativeLinuxDir = pathModule.join(options.homeDir, ".local", "share", ...SAVE_PARTS);
  return firstExisting([...protonDirs, standardDocumentsDir, nativeLinuxDir], options.existsSync);
}

function defaultGameDir(options) {
  const pathModule = options.pathModule || path;
  const homeDir = options.homeDir;
  let candidates;

  if (options.platform === "linux") {
    candidates = linuxSteamRoots(homeDir, pathModule).map((steamRoot) =>
      pathModule.join(steamRoot, "steamapps", "common", GAME_FOLDER)
    );
  } else if (options.platform === "darwin") {
    candidates = [
      pathModule.join(homeDir, "Library", "Application Support", "Steam", "steamapps", "common", GAME_FOLDER),
    ];
  } else {
    const programFilesX86 = options.programFilesX86 || "C:\\Program Files (x86)";
    const programFiles = options.programFiles || "C:\\Program Files";
    candidates = [
      pathModule.join(programFilesX86, "Steam", "steamapps", "common", GAME_FOLDER),
      pathModule.join(programFiles, "Steam", "steamapps", "common", GAME_FOLDER),
    ];
  }

  return firstExisting(candidates, options.existsSync);
}

module.exports = {
  EU5_STEAM_APP_ID,
  defaultSaveDir,
  defaultGameDir,
  firstExisting,
  linuxSteamRoots,
};
