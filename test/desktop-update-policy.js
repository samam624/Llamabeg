"use strict";

const assert = require("assert");
const path = require("path");
const UpdatePolicy = require("../llama-dashboard/update-policy.js");

const execPath = path.join("C:\\", "Users", "Tester", "AppData", "Local", "LlamaScoreDashboard", "app-1.0.1", "LlamaScoreDashboard.exe");
const expectedUpdateExe = path.resolve(path.dirname(execPath), "..", "Update.exe");

assert.strictEqual(UpdatePolicy.UPDATE_REPOSITORY, "samam624/Llamabeg");
assert.match(UpdatePolicy.RELEASE_API_URL, /samam624\/Llamabeg\/releases\/latest$/);
assert.strictEqual(UpdatePolicy.squirrelUpdateExe(execPath), expectedUpdateExe);

assert.deepStrictEqual(
  UpdatePolicy.updateEligibility({
    isPackaged: false,
    platform: "win32",
    execPath,
    argv: [],
    handlingSquirrelEvent: false,
  }),
  { enabled: false, reason: "development build" }
);

const portable = UpdatePolicy.updateEligibility({
  isPackaged: true,
  platform: "win32",
  execPath,
  argv: [],
  handlingSquirrelEvent: false,
  existsSync: () => false,
});
assert.strictEqual(portable.enabled, false);
assert.match(portable.reason, /portable build/);

const installed = UpdatePolicy.updateEligibility({
  isPackaged: true,
  platform: "win32",
  execPath,
  argv: [],
  handlingSquirrelEvent: false,
  existsSync: (candidate) => candidate === expectedUpdateExe,
});
assert.strictEqual(installed.enabled, true);
assert.strictEqual(installed.mode, "automatic");
assert.strictEqual(installed.delayMs, 0);

const firstRun = UpdatePolicy.updateEligibility({
  isPackaged: true,
  platform: "win32",
  execPath,
  argv: ["--squirrel-firstrun"],
  handlingSquirrelEvent: false,
  existsSync: () => true,
});
assert.strictEqual(firstRun.enabled, true);
assert.strictEqual(firstRun.delayMs, UpdatePolicy.SQUIRREL_FIRST_RUN_DELAY_MS);

assert.strictEqual(
  UpdatePolicy.updateEligibility({
    isPackaged: true,
    platform: "win32",
    execPath,
    argv: [],
    handlingSquirrelEvent: true,
    existsSync: () => true,
  }).enabled,
  false
);

for (const platform of ["darwin", "linux"]) {
  const eligibility = UpdatePolicy.updateEligibility({
    isPackaged: true,
    platform,
    execPath: "/Applications/Llama Score Dashboard",
    argv: [],
    handlingSquirrelEvent: false,
  });
  assert.strictEqual(eligibility.enabled, true);
  assert.strictEqual(eligibility.mode, "manual");
}

assert.strictEqual(UpdatePolicy.isNewerVersion("1.0.2", "v1.1.0"), true);
assert.strictEqual(UpdatePolicy.isNewerVersion("1.1.0", "v1.1.0"), false);
assert.strictEqual(UpdatePolicy.isNewerVersion("2.0.0", "v1.9.9"), false);
assert.strictEqual(UpdatePolicy.isNewerVersion("invalid", "v1.1.0"), false);

console.log("desktop update policy: ok");
