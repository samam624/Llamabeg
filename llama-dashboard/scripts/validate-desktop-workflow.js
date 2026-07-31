#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
const UpdatePolicy = require("../update-policy.js");

const workflowPath = path.join(__dirname, "..", "..", ".github", "workflows", "desktop-release.yml");
const workflowText = fs.readFileSync(workflowPath, "utf8");
const workflow = YAML.parse(workflowText);
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

assert.ok(workflow && workflow.on && workflow.on.workflow_dispatch !== undefined, "workflow_dispatch trigger is required");
assert.deepStrictEqual(workflow.on.push.tags, ["v*.*.*"]);
assert.strictEqual(UpdatePolicy.UPDATE_REPOSITORY, "samam624/Llamabeg");
assert.strictEqual(workflow.env.RELEASE_REPOSITORY, "${{ github.repository }}");
assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);

assert.strictEqual(workflow.permissions.contents, "write");

const windowsJob = workflow.jobs && workflow.jobs["build-windows"];
const macJob = workflow.jobs && workflow.jobs["build-macos"];
const linuxJob = workflow.jobs && workflow.jobs["build-linux"];
const publishJob = workflow.jobs && workflow.jobs.publish;
assert.ok(windowsJob && macJob && linuxJob && publishJob, "Windows, macOS, Linux, and publish jobs are required");
assert.strictEqual(windowsJob["runs-on"], "windows-latest");

const macMatrix = macJob.strategy.matrix.include;
assert.ok(macMatrix.some((entry) => entry.runner === "macos-15-intel" && entry.arch === "x64"));
assert.ok(macMatrix.some((entry) => entry.runner === "macos-15" && entry.arch === "arm64"));
const linuxMatrix = linuxJob.strategy.matrix.include;
assert.ok(linuxMatrix.some((entry) => entry.runner === "ubuntu-24.04" && entry.arch === "x64"));
assert.ok(linuxMatrix.some((entry) => entry.runner === "ubuntu-24.04-arm" && entry.arch === "arm64"));

for (const job of [windowsJob, macJob, linuxJob]) {
  assert.ok(
    (job.steps || []).some((step) => step.uses === "actions/upload-artifact@v4"),
    "each platform job must retain verified artifacts"
  );
}

assert.strictEqual(publishJob.if, "github.ref_type == 'tag'");
assert.deepStrictEqual(publishJob.needs, ["build-windows", "build-macos", "build-linux"]);
const publishStep = (publishJob.steps || []).find((step) => step.name === "Publish verified multi-platform release");
assert.ok(publishStep, "verified multi-platform publish step is required");
assert.match(publishStep.run, /gh release create/);
assert.match(publishStep.run, /--verify-tag/);
assert.match(workflowText, /verify-update-release -- --require-signed --tag/);
assert.match(workflowText, /verify-update-release -- --tag/);
assert.match(workflowText, /published unsigned/);
assert.match(workflowText, /Llama-Score-Dashboard-macOS-arm64\.dmg/);
assert.match(workflowText, /Llama-Score-Dashboard-macOS-x64\.dmg/);
assert.match(workflowText, /Llama-Score-Dashboard-Linux-arm64\.deb/);
assert.match(workflowText, /Llama-Score-Dashboard-Linux-x64\.rpm/);
assert.match(workflowText, /campaignDataFiles=0|verification-\*\.json/);
assert.match(workflowText, /GH_TOKEN: \$\{\{ github\.token \}\}/);
assert.doesNotMatch(workflowText, /RELEASES_TOKEN/);
assert.match(workflowText, /secrets\.WINDOWS_CERTIFICATE_PFX_BASE64/);
assert.match(workflowText, /secrets\.WINDOWS_CERTIFICATE_PASSWORD/);

console.log("desktop release workflow: ok");
