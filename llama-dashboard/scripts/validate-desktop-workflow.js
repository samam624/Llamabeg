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

const job = workflow.jobs && workflow.jobs["build-windows"];
assert.ok(job, "build-windows job is required");
assert.strictEqual(job["runs-on"], "windows-latest");
assert.strictEqual(workflow.permissions.contents, "write");
const steps = job.steps || [];
assert.ok(steps.some((step) => step.uses === "actions/upload-artifact@v4"), "verified artifacts must be retained");
const publishStep = steps.find((step) => step.name === "Publish verified update release");
assert.ok(publishStep, "verified publish step is required");
assert.strictEqual(publishStep.if, "github.ref_type == 'tag'");
assert.match(publishStep.run, /gh release create/);
assert.match(publishStep.run, /--verify-tag/);
assert.match(workflowText, /verify-update-release -- --require-signed --tag/);
assert.match(workflowText, /verify-update-release -- --tag/);
assert.match(workflowText, /published unsigned/);
assert.match(workflowText, /GH_TOKEN: \$\{\{ github\.token \}\}/);
assert.doesNotMatch(workflowText, /RELEASES_TOKEN/);
assert.match(workflowText, /secrets\.WINDOWS_CERTIFICATE_PFX_BASE64/);
assert.match(workflowText, /secrets\.WINDOWS_CERTIFICATE_PASSWORD/);

console.log("desktop release workflow: ok");
