#!/usr/bin/env node
"use strict";

const path = require("path");
const { spawnSync } = require("child_process");

function translateArgs(args) {
  return args.map((arg) => {
    if (arg === "--require-signed") return "-RequireSigned";
    if (arg === "--tag") return "-Tag";
    return arg;
  });
}

if (require.main === module) {
  const script = path.join(__dirname, "verify-update-release.ps1");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...translateArgs(process.argv.slice(2))],
    { stdio: "inherit" }
  );

  if (result.error) throw result.error;
  process.exitCode = result.status == null ? 1 : result.status;
}

module.exports = { translateArgs };
