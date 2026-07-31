"use strict";

const assert = require("assert");
const path = require("path");
const PlatformPaths = require("../llama-dashboard/platform-paths.js");

const posix = path.posix;
const linuxHome = "/home/tester";
const documentsDir = "/home/tester/Documents";
const protonSaveDir = posix.join(
  linuxHome,
  ".local",
  "share",
  "Steam",
  "steamapps",
  "compatdata",
  PlatformPaths.EU5_STEAM_APP_ID,
  "pfx",
  "drive_c",
  "users",
  "steamuser",
  "Documents",
  "Paradox Interactive",
  "Europa Universalis V",
  "save games"
);

assert.strictEqual(
  PlatformPaths.defaultSaveDir({
    platform: "linux",
    homeDir: linuxHome,
    documentsDir,
    pathModule: posix,
    existsSync: (candidate) => candidate === protonSaveDir,
  }),
  protonSaveDir
);

assert.strictEqual(
  PlatformPaths.defaultSaveDir({
    platform: "darwin",
    homeDir: "/Users/tester",
    documentsDir: "/Users/tester/Documents",
    pathModule: posix,
    existsSync: () => false,
  }),
  "/Users/tester/Documents/Paradox Interactive/Europa Universalis V/save games"
);

const flatpakGameDir = "/home/tester/.var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/common/Europa Universalis V";
assert.strictEqual(
  PlatformPaths.defaultGameDir({
    platform: "linux",
    homeDir: linuxHome,
    pathModule: posix,
    existsSync: (candidate) => candidate === flatpakGameDir,
  }),
  flatpakGameDir
);

console.log("desktop platform paths: ok");
