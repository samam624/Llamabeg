"use strict";

const path = require("path");

const iconByPlatform = {
  win32: path.join(__dirname, "assets", "llama-logo.ico"),
  darwin: path.join(__dirname, "assets", "llama-logo.icns"),
  linux: path.join(__dirname, "assets", "llama-logo-avatar.png"),
};
const certificateFile = process.env.WINDOWS_CERTIFICATE_FILE;
const certificatePassword = process.env.WINDOWS_CERTIFICATE_PASSWORD;
if (Boolean(certificateFile) !== Boolean(certificatePassword)) {
  throw new Error("WINDOWS_CERTIFICATE_FILE and WINDOWS_CERTIFICATE_PASSWORD must either both be set or both be omitted.");
}
const windowsSign = certificateFile
  ? {
      certificateFile,
      certificatePassword,
      hashes: ["sha256"],
      timestampServer: process.env.WINDOWS_TIMESTAMP_URL || "http://timestamp.digicert.com",
      description: "Llama Score Dashboard",
      website: "https://llamabeg.netlify.app",
    }
  : undefined;

module.exports = {
  packagerConfig: {
    name: "Llama Score Dashboard",
    executableName: "LlamaScoreDashboard",
    icon: iconByPlatform[process.platform],
    asar: false,
    appBundleId: "com.llamabeg.llamascoredashboard",
    appCategoryType: "public.app-category.utilities",
    extendInfo: {
      NSDocumentsFolderUsageDescription: "Llama Score Dashboard reads EU5 saves and stores campaign history in Documents.",
    },
    ...(process.platform === "darwin" ? { osxSign: { identity: "-", identityValidation: false } } : {}),
    ...(windowsSign ? { windowsSign } : {}),
    ignore: [
      /^\/out(?:\/|$)/,
      /^\/release(?:\/|$)/,
      /^\/assets\/llama-logo\.iconset(?:\/|$)/,
      /^\/(?!main\.js$|preload\.js$|data-paths\.js$|platform-paths\.js$|update-policy\.js$|renderer(?:\/|$)|package\.json$|vendor(?:\/|$)|assets(?:\/|$)|node_modules(?:\/|$))/,
      /^\/node_modules\/(?!(?:electron-squirrel-startup|update-electron-app|github-url-to-object|is-url|ms)(?:\/|$))/,
    ],
  },
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      platforms: ["win32"],
      config: {
        name: "LlamaScoreDashboard",
        authors: "Llamabeg",
        description: "EU5 Llama Score campaign recorder and desktop dashboard.",
        setupExe: "Llama-Score-Dashboard-Setup.exe",
        setupIcon: path.join(__dirname, "assets", "llama-logo.ico"),
        noMsi: true,
        ...(windowsSign ? { windowsSign } : {}),
      },
    },
    {
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
      config: {},
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin", "linux"],
      config: {},
    },
    {
      name: "@electron-forge/maker-deb",
      platforms: ["linux"],
      config: {
        options: {
          name: "llama-score-dashboard",
          productName: "Llama Score Dashboard",
          genericName: "EU5 campaign dashboard",
          description: "EU5 campaign recorder and Llama Score dashboard.",
          maintainer: "Llamabeg <264945189+samam624@users.noreply.github.com>",
          homepage: "https://github.com/samam624/Llamabeg",
          bin: "LlamaScoreDashboard",
          icon: path.join(__dirname, "assets", "llama-logo-avatar.png"),
          categories: ["Game", "Utility"],
        },
      },
    },
    {
      name: "@electron-forge/maker-rpm",
      platforms: ["linux"],
      config: {
        options: {
          name: "llama-score-dashboard",
          productName: "Llama Score Dashboard",
          genericName: "EU5 campaign dashboard",
          description: "EU5 campaign recorder and Llama Score dashboard.",
          license: "UNLICENSED",
          homepage: "https://github.com/samam624/Llamabeg",
          bin: "LlamaScoreDashboard",
          icon: path.join(__dirname, "assets", "llama-logo-avatar.png"),
          categories: ["Game", "Utility"],
        },
      },
    },
  ],
};
