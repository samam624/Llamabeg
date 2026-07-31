#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const dashboardRoot = path.join(__dirname, "..");
const outRoot = path.join(dashboardRoot, "out");
const makeRoot = path.join(outRoot, "make");
const stageRoot = path.join(dashboardRoot, "release-assets");
const packageJson = JSON.parse(fs.readFileSync(path.join(dashboardRoot, "package.json"), "utf8"));

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--platform" || arg === "--arch" || arg === "--tag") {
      options[arg.slice(2)] = argv[++index];
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }
  if (!["win32", "darwin", "linux"].includes(options.platform)) fail("--platform must be win32, darwin, or linux");
  if (!["x64", "arm64"].includes(options.arch)) fail("--arch must be x64 or arm64");
  if (options.platform === "win32" && options.arch !== "x64") fail("Only Windows x64 is currently released");
  return options;
}

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  }
  return files.sort();
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function assertPackageMetadata(appRoot) {
  const packaged = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
  for (const field of ["name", "version", "productName", "main"]) {
    if (packaged[field] !== packageJson[field]) fail(`Packaged package.json has an unexpected ${field}`);
  }
  const expectedDependencies = Object.entries(packageJson.dependencies || {}).sort();
  const actualDependencies = Object.entries(packaged.dependencies || {}).sort();
  if (JSON.stringify(actualDependencies) !== JSON.stringify(expectedDependencies)) {
    fail("Packaged package.json has an unexpected production dependency set");
  }
}

function assertPackagedRuntime(platform, arch) {
  const packageDir = path.join(outRoot, `Llama Score Dashboard-${platform}-${arch}`);
  const appBundle = path.join(packageDir, "Llama Score Dashboard.app");
  const appRoot =
    platform === "darwin"
      ? path.join(appBundle, "Contents", "Resources", "app")
      : path.join(packageDir, "resources", "app");
  if (!fs.existsSync(appRoot)) fail(`Packaged app root not found: ${appRoot}`);

  const runtimeFiles = [
    "main.js",
    "preload.js",
    "data-paths.js",
    "platform-paths.js",
    "update-policy.js",
    path.join("vendor", "llama-score-automatic-logging-machine", "llama-log-machine.js"),
    path.join("vendor", "llama-score-automatic-logging-machine", "parse-worker.js"),
  ];
  for (const relativePath of runtimeFiles) {
    const sourcePath = path.join(dashboardRoot, relativePath);
    const packagedPath = path.join(appRoot, relativePath);
    if (!fs.existsSync(packagedPath) || sha256(sourcePath) !== sha256(packagedPath)) {
      fail(`Packaged runtime does not match source: ${relativePath}`);
    }
  }
  assertPackageMetadata(appRoot);

  const campaignDataFiles = walkFiles(path.join(appRoot, "data"));
  if (campaignDataFiles.length) fail(`Packaged app contains campaign data: ${campaignDataFiles.join(", ")}`);
  if (platform === "darwin") {
    const signatureCheck = childProcess.spawnSync("codesign", ["--verify", "--deep", "--strict", appBundle], {
      encoding: "utf8",
    });
    if (signatureCheck.status !== 0) {
      fail(`macOS app bundle failed code-signature verification: ${signatureCheck.stderr || signatureCheck.stdout}`);
    }
  }
  return appRoot;
}

function oneArtifact(extension, candidates) {
  const matches = candidates.filter((candidate) => candidate.toLowerCase().endsWith(extension));
  if (matches.length !== 1) fail(`Expected exactly one ${extension} artifact, found ${matches.length}`);
  const stat = fs.statSync(matches[0]);
  if (stat.size < 1024 * 1024) fail(`Artifact is unexpectedly small: ${matches[0]}`);
  return matches[0];
}

function artifactMap(platform, arch) {
  if (platform === "win32") {
    const squirrelDir = path.join(makeRoot, "squirrel.windows", "x64");
    return new Map([
      ["Llama-Score-Dashboard-Setup.exe", path.join(squirrelDir, "Llama-Score-Dashboard-Setup.exe")],
      [`LlamaScoreDashboard-${packageJson.version}-full.nupkg`, path.join(squirrelDir, `LlamaScoreDashboard-${packageJson.version}-full.nupkg`)],
      ["RELEASES", path.join(squirrelDir, "RELEASES")],
      ["Llama-Score-Dashboard-win32-x64.zip", path.join(dashboardRoot, "release", "Llama-Score-Dashboard-win32-x64.zip")],
    ]);
  }

  const makeFiles = walkFiles(makeRoot);
  if (platform === "darwin") {
    return new Map([
      [`Llama-Score-Dashboard-macOS-${arch}.dmg`, oneArtifact(".dmg", makeFiles)],
      [`Llama-Score-Dashboard-macOS-${arch}.zip`, oneArtifact(".zip", makeFiles)],
    ]);
  }
  return new Map([
    [`Llama-Score-Dashboard-Linux-${arch}.deb`, oneArtifact(".deb", makeFiles)],
    [`Llama-Score-Dashboard-Linux-${arch}.rpm`, oneArtifact(".rpm", makeFiles)],
    [`Llama-Score-Dashboard-Linux-${arch}.zip`, oneArtifact(".zip", makeFiles)],
  ]);
}

function stage(options) {
  const expectedTag = `v${packageJson.version}`;
  if (options.tag && options.tag !== expectedTag) {
    fail(`Release tag ${options.tag} does not match package version ${packageJson.version}`);
  }
  if (options.platform !== "win32") assertPackagedRuntime(options.platform, options.arch);

  fs.mkdirSync(stageRoot, { recursive: true });
  const manifest = {
    version: packageJson.version,
    tag: expectedTag,
    platform: options.platform,
    arch: options.arch,
    campaignDataFiles: 0,
    artifacts: [],
  };
  for (const [publicName, sourcePath] of artifactMap(options.platform, options.arch)) {
    if (!fs.existsSync(sourcePath)) fail(`Missing release artifact: ${sourcePath}`);
    const destination = path.join(stageRoot, publicName);
    fs.copyFileSync(sourcePath, destination);
    const stat = fs.statSync(destination);
    manifest.artifacts.push({ name: publicName, size: stat.size, sha256: sha256(destination) });
    console.log(`VERIFIED|${publicName}|${stat.size}|SHA256=${sha256(destination)}`);
  }
  const manifestName = `verification-${options.platform}-${options.arch}.json`;
  fs.writeFileSync(path.join(stageRoot, manifestName), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`VERIFIED|version=${packageJson.version}|tag=${expectedTag}|platform=${options.platform}|arch=${options.arch}|campaignDataFiles=0`);
}

stage(parseArgs(process.argv.slice(2)));
