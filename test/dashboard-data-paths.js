"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const DataPaths = require("../llama-dashboard/data-paths.js");

const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llama-data-path-test-"));
try {
  const appDir = path.join(probeRoot, "portable-app");
  const legacyDir = path.join(appDir, "data");
  const documentsDir = path.join(probeRoot, "Documents");
  fs.mkdirSync(path.join(legacyDir, "campaigns", "campaign-a"), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "state.json"), "{\"ok\":true}\n");
  fs.writeFileSync(path.join(legacyDir, "campaigns", "campaign-a", "snapshots.jsonl"), "{\"date\":\"1500.1.1\"}\n");

  const targetDir = DataPaths.resolveDefaultDataDir({
    isPackaged: true,
    execPath: path.join(appDir, "Llama Score Dashboard.exe"),
    documentsDir,
    devDataDir: "unused",
  });
  assert.strictEqual(targetDir, path.join(documentsDir, "Llamabeg", "Campaign Data"));
  assert.ok(DataPaths.inventoriesMatch(DataPaths.inventoryDirectory(legacyDir), DataPaths.inventoryDirectory(targetDir)));
  assert.ok(fs.existsSync(path.join(legacyDir, "state.json")), "legacy backup should remain");

  fs.writeFileSync(path.join(legacyDir, "state.json"), "{\"changed\":true}\n");
  const secondResolution = DataPaths.resolveDefaultDataDir({
    isPackaged: true,
    execPath: path.join(appDir, "Llama Score Dashboard.exe"),
    documentsDir,
    devDataDir: "unused",
  });
  assert.strictEqual(secondResolution, targetDir);
  assert.strictEqual(fs.readFileSync(path.join(targetDir, "state.json"), "utf8"), "{\"ok\":true}\n");

  // An installed Squirrel app runs from LocalAppData, so its executable is
  // no longer beside the old portable ledger. Confirm the known extracted
  // Documents location is still discovered and migrated.
  const installedDocumentsDir = path.join(probeRoot, "InstalledDocuments");
  const extractedLegacyDir = path.join(installedDocumentsDir, "Llama-Score-Dashboard-win32-x64", "data");
  fs.mkdirSync(path.join(extractedLegacyDir, "campaigns", "campaign-b"), { recursive: true });
  fs.writeFileSync(path.join(extractedLegacyDir, "state.json"), "{\"installed\":true}\n");
  fs.writeFileSync(
    path.join(extractedLegacyDir, "campaigns", "campaign-b", "snapshots.jsonl"),
    "{\"date\":\"1510.1.1\"}\n"
  );
  const installedTargetDir = DataPaths.resolveDefaultDataDir({
    isPackaged: true,
    execPath: path.join(probeRoot, "LocalAppData", "app-1.0.1", "LlamaScoreDashboard.exe"),
    documentsDir: installedDocumentsDir,
    legacyDirs: [
      path.join(probeRoot, "LocalAppData", "app-1.0.1", "data"),
      extractedLegacyDir,
    ],
    devDataDir: "unused",
  });
  assert.strictEqual(installedTargetDir, path.join(installedDocumentsDir, "Llamabeg", "Campaign Data"));
  assert.ok(
    DataPaths.inventoriesMatch(
      DataPaths.inventoryDirectory(extractedLegacyDir),
      DataPaths.inventoryDirectory(installedTargetDir)
    )
  );
  assert.ok(fs.existsSync(path.join(extractedLegacyDir, "state.json")), "extracted legacy backup should remain");

  const devDir = path.join(probeRoot, "dev-data");
  assert.strictEqual(
    DataPaths.resolveDefaultDataDir({
      isPackaged: false,
      execPath: "unused",
      documentsDir,
      devDataDir: devDir,
    }),
    devDir
  );
  console.log("dashboard data paths: ok");
} finally {
  const tempRoot = path.resolve(os.tmpdir());
  const resolvedProbe = path.resolve(probeRoot);
  if (!resolvedProbe.startsWith(tempRoot + path.sep) || !path.basename(resolvedProbe).startsWith("llama-data-path-test-")) {
    throw new Error(`Refusing to remove unexpected test path: ${resolvedProbe}`);
  }
  fs.rmSync(resolvedProbe, { recursive: true, force: true });
}
