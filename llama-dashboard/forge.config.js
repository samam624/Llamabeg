"use strict";

const path = require("path");

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
    icon: path.join(__dirname, "assets", "llama-logo.ico"),
    asar: false,
    ...(windowsSign ? { windowsSign } : {}),
    ignore: [
      /^\/out(?:\/|$)/,
      /^\/release(?:\/|$)/,
      /^\/(?!main\.js$|preload\.js$|data-paths\.js$|update-policy\.js$|renderer(?:\/|$)|package\.json$|vendor(?:\/|$)|assets(?:\/|$)|node_modules(?:\/|$))/,
      /^\/node_modules\/(?!(?:electron-squirrel-startup|update-electron-app|github-url-to-object|is-url|ms)(?:\/|$))/,
    ],
  },
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
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
  ],
};
