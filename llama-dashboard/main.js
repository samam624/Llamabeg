"use strict";

// Embeds the exact same recorder scan loop the CLI (llama-log-machine.js)
// uses - see vendorPath() below - instead of reimplementing save-watching/
// parsing, or shelling out to a separate `node` process this app would have
// no control over. Don't run the standalone CLI recorder at the same time
// as this app against the same data dir: both would append to the same
// snapshots.jsonl/war-events.jsonl/state.json concurrently, which can
// interleave writes and corrupt the ledger.

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");

// Two copies of this app (e.g. one launched from an old unzipped folder, one
// from a fresh re-download elsewhere) polling and writing to the same
// sibling `data` folder at once is exactly the concurrent-write corruption
// risk the comment above already warns about for the standalone CLI - a
// single-instance lock keeps that to one running copy regardless of which
// extracted folder it was started from (Electron keys this off the app's own
// identity, not its install path). If a second copy is launched, focus the
// existing window instead of starting a second recorder loop.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// Ledger lives next to the exe in a packaged (unzipped-and-run) install, so
// a fresh download "just works" - the web app's "Connect campaign folder..."
// picker then points at that same sibling `data` folder to share one ledger
// instead of starting a second, disconnected one. In dev (`npm start`),
// falls back to the repo's shared recorder data dir instead.
function defaultDataDir() {
  if (app.isPackaged) return path.join(path.dirname(process.execPath), "data");
  return path.join(__dirname, "..", "llama-score-automatic-logging-machine", "data");
}

function vendorPath(...parts) {
  return app.isPackaged ? path.join(process.resourcesPath, "app", "vendor", ...parts) : path.join(__dirname, "..", ...parts);
}

const Recorder = require(vendorPath("llama-score-automatic-logging-machine", "llama-log-machine.js"));
const LlamaScore = require(vendorPath("js", "llama-score.js"));

// --- settings (save dir / data dir overrides), persisted per-user ---

function settingsFile() {
  return path.join(app.getPath("userData"), "settings.json");
}
function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
  } catch {
    return {};
  }
}
function saveSettingsToDisk(settings) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

function buildConfig() {
  const settings = loadSettings();
  const args = {};
  if (settings.saveDir) args.saveDir = settings.saveDir;
  // A saved dataDir can point at a NOW-GONE extraction of this app - e.g. the
  // user unzipped a fresh copy somewhere else and deleted the old one. Simply
  // opening Settings once (even without changing anything - see settings:get/
  // settings:save below) used to be enough to permanently pin that session's
  // sibling-of-the-CURRENT-exe path into this shared (per-user, not
  // per-install) settings file, so every future run - including from a
  // totally different unzipped copy - kept pointing at a folder that might no
  // longer exist. Only honor a saved dataDir if it still actually exists;
  // otherwise fall through to a fresh defaultDataDir() for THIS exe, same as
  // if nothing had ever been saved.
  const cachedDataDirValid = typeof settings.dataDir === "string" && settings.dataDir && fs.existsSync(settings.dataDir);
  if (cachedDataDirValid) args.dataDir = settings.dataDir;
  const config = Recorder.readConfig(args);
  if (!cachedDataDirValid) config.dataDir = defaultDataDir();
  config.campaignsDir = path.join(config.dataDir, "campaigns");
  return config;
}

// --- in-memory log ring buffer, so the UI can show recent recorder activity ---

const LOG_LIMIT = 300;
const logLines = [];
function pushLog(line) {
  logLines.push({ at: new Date().toISOString(), line: String(line) });
  if (logLines.length > LOG_LIMIT) logLines.shift();
}
const realConsoleLog = console.log.bind(console);
const realConsoleWarn = console.warn.bind(console);
console.log = (...a) => {
  pushLog(a.map(String).join(" "));
  realConsoleLog(...a);
};
console.warn = (...a) => {
  pushLog("WARN: " + a.map(String).join(" "));
  realConsoleWarn(...a);
};

// --- recorder state + scan loop ---

let config = null;
let state = null;
let pollTimer = null;
let scanning = false;
let mainWindow = null;
let lastError = null;

function stateFile() {
  return path.join(config.dataDir, "state.json");
}

async function initRecorder() {
  config = buildConfig();
  Recorder.ensureDir(config.dataDir);
  state = Recorder.loadJson(stateFile(), { files: {}, hashes: {}, activeWarsByCampaign: {}, checkpoints: {}, lastSnapshot: null, lastDateByCampaign: {} });
  state.activeWarsByCampaign = state.activeWarsByCampaign || {};
  state.lastDateByCampaign = state.lastDateByCampaign || {};
  Recorder.migrateLegacyLedgerIfNeeded(config);
  Recorder.hydrateStateFromSnapshots(config, state);
  pushLog(`Llama Score Dashboard - watching ${config.saveDir}`);
  pushLog(`Data dir: ${config.dataDir}`);
}

async function tick() {
  if (scanning) return;
  scanning = true;
  try {
    await Recorder.scan(config, state);
    lastError = null;
  } catch (err) {
    lastError = err.message || String(err);
    console.warn(`Scan failed: ${lastError}`);
  } finally {
    scanning = false;
  }
  pushUpdate();
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(tick, config.pollMs || 5000);
}

async function restartRecorder() {
  if (pollTimer) clearInterval(pollTimer);
  await initRecorder();
  await tick();
  startPolling();
}

// --- ledger reading (mtime-cached so a long campaign's jsonl isn't
// re-read from scratch on every 5s tick once it gets large) ---

const ledgerCache = new Map(); // campaignKey -> { snapMtime, eventMtime, snapshots, events }

function parseJsonl(text) {
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // Skip a malformed line (e.g. truncated by a killed recorder process).
    }
  }
  return records;
}

// `file` is always the LOGICAL plain-file path (e.g. .../snapshots.jsonl) -
// gz-aware, so it works whether that campaign is currently plain or
// compacted to its .jsonl.gz twin (see llama-log-machine.js's
// compactCampaignLedger).
function statMtime(file) {
  const stat = Recorder.statLedgerFile(file);
  return stat ? stat.mtimeMs : 0;
}

// Set via the renderer's Campaign picker (see ipcMain "campaigns:select"
// below) to view a PAST campaign instead of whatever the recorder is
// currently watching live - deliberately session-only (never persisted),
// so relaunching the app always comes back to auto/live-tracking rather
// than getting silently "stuck" showing old data the user forgot they'd
// pinned. Does NOT affect what the embedded recorder itself scans/records
// in the background (that's always governed by config.campaignMode,
// "latest" by default) - pinning only changes what this window DISPLAYS.
let pinnedCampaignKey = null;

function currentCampaignKey() {
  if (pinnedCampaignKey) {
    if (fs.existsSync(path.join(config.campaignsDir, pinnedCampaignKey))) return pinnedCampaignKey;
    pinnedCampaignKey = null; // folder's gone (renamed/deleted) - fall through to auto below
  }
  if (state.lastSnapshot && state.lastSnapshot.campaignKey) return state.lastSnapshot.campaignKey;
  if (!fs.existsSync(config.campaignsDir)) return null;
  let best = null;
  for (const d of fs.readdirSync(config.campaignsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const mtime = statMtime(path.join(config.campaignsDir, d.name, "snapshots.jsonl"));
    if (mtime && (!best || mtime > best.mtime)) best = { key: d.name, mtime };
  }
  return best ? best.key : null;
}

// Reads only the tail of a (potentially large) snapshots.jsonl to pull the
// last record's metadata for the campaign picker list - avoids parsing an
// entire multi-megabyte ledger just to show a name and a date for every
// campaign in the picker. Falls back to null (picker still shows the raw
// folder name/mtime) if even the tail has no complete, parseable line. A
// compacted (.gz) campaign skips the tail-seek entirely and just
// decompresses+parses the whole thing - gzip can't be efficiently seeked
// into near the end, but a compacted file is small by definition (that's
// the point of compacting it), so this is cheap regardless.
function readLastJsonlRecord(file, maxBytes) {
  maxBytes = maxBytes || 65536;
  try {
    let text;
    if (fs.existsSync(file)) {
      const size = fs.statSync(file).size;
      const start = Math.max(0, size - maxBytes);
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      text = buf.toString("utf8");
    } else {
      text = Recorder.readLedgerText(file);
    }
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i]);
      } catch {
        continue; // possibly a truncated partial line at the start of our read window
      }
    }
  } catch {
    // Missing/unreadable file - picker falls back to folder name/mtime only.
  }
  return null;
}

function listCampaigns() {
  if (!fs.existsSync(config.campaignsDir)) return [];
  const results = [];
  for (const d of fs.readdirSync(config.campaignsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const snapFile = path.join(config.campaignsDir, d.name, "snapshots.jsonl");
    if (!fs.existsSync(snapFile) && !fs.existsSync(snapFile + ".gz")) continue;
    const last = readLastJsonlRecord(snapFile);
    results.push({
      campaignKey: d.name,
      playthroughName: (last && last.playthroughName) || null,
      date: (last && last.date) || null,
      capturedAt: (last && last.capturedAt) || null,
      mtimeMs: statMtime(snapFile),
    });
  }
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results;
}

function readCampaignLedger(campaignKey) {
  const snapFile = Recorder.campaignSnapshotsFile(config, campaignKey);
  const eventFile = Recorder.campaignEventsFile(config, campaignKey);
  const snapMtime = statMtime(snapFile);
  const eventMtime = statMtime(eventFile);
  const cached = ledgerCache.get(campaignKey);
  if (cached && cached.snapMtime === snapMtime && cached.eventMtime === eventMtime) return cached;

  const snapshots = parseJsonl(Recorder.readLedgerText(snapFile));
  const events = parseJsonl(Recorder.readLedgerText(eventFile));
  const entry = { snapMtime, eventMtime, snapshots, events };
  ledgerCache.set(campaignKey, entry);
  return entry;
}

// --- hidden/departed players (per campaign, shared with the web app) ---
//
// A player who quietly stops showing up, with nobody else ever taking over
// their seat, is genuinely invisible to the save/ledger data - confirmed by
// direct inspection of a real campaign's own snapshots and raw save file
// (see [[player_session_handling]]): the country's `players` list, and even
// `ai_personality`, are byte-identical whether a human is still actively
// connected or gave up on the campaign entirely. There is no field to auto-
// detect this from, so this is a one-time manual action (the "Hide" button
// below) rather than something the recorder can infer on its own.
//
// Stored as a small JSON file NEXT TO that campaign's own ledger
// (data/campaigns/<key>/hidden-players.json, name -> in-game date they were
// marked departed as of, or null if unknown) rather than in this app's own
// settings/userData - so the SAME hide, made once here, is immediately
// visible to the web app too (it already has read access to this same
// campaign folder via "Connect campaign folder..."), and vice versa if the
// web app ever writes one. `js/llama-score.js`'s computeFromLedger only
// treats a war as excluded once it STARTED at-or-after the recorded date -
// a war fought while the player was still genuinely active keeps its real
// score, only wars against/by a phantom opponent get excluded. See
// buildModeView below for how this gets threaded into scoring.
function hiddenPlayersFile(campaignKey) {
  return path.join(config.campaignsDir, campaignKey, "hidden-players.json");
}
function readHiddenPlayers(campaignKey) {
  try {
    const raw = JSON.parse(fs.readFileSync(hiddenPlayersFile(campaignKey), "utf8"));
    return new Map(Object.entries(raw));
  } catch {
    return new Map();
  }
}
function writeHiddenPlayers(campaignKey, map) {
  fs.mkdirSync(path.dirname(hiddenPlayersFile(campaignKey)), { recursive: true });
  fs.writeFileSync(hiddenPlayersFile(campaignKey), JSON.stringify(Object.fromEntries(map), null, 2));
}

function countryLabel(countries, playerCountries, number) {
  const info = (countries && countries[number]) || (playerCountries || []).find((c) => c.number === number);
  return {
    number,
    tag: (info && info.tag) || "#" + number,
    players: info && info.players && info.players.length ? info.players : [],
    locationCount: (info && info.locationCount) || 0,
  };
}

// `mode` splits the SAME latest-snapshot war list into "ongoing player
// wars" (both sides have had a real player at some point) vs. "ongoing PvE
// wars" (opposing side has never been anyone but AI) - mirrors the
// isPvP/mode split js/llama-score.js's computeFromLedger applies to
// CONCLUDED wars, just computed directly off the live snapshot since
// ongoing wars have no war-disappeared event yet to read from.
function buildOngoingWars(latestSnapshot, mode) {
  if (!latestSnapshot) return [];
  const countries = Object.assign({}, latestSnapshot.countries, latestSnapshot.economyCountries);
  const playerCountryNums = new Set((latestSnapshot.playerCountries || []).map((c) => c.number));
  // Same subject-collapsing js/llama-score.js already applies to concluded-
  // war scoring (excludeSubjectsOfPresentOverlords) - a war side listing
  // "the Ottomans + 3 vassals" should read as one belligerent, not four,
  // here too. Never drops an actual player's own country even if their
  // overlord is also on the same side - hiding a real player from their own
  // war would be worse than the vassal clutter this is fixing.
  function overlordOf(n) {
    const info = countries[n] || (latestSnapshot.playerCountries || []).find((c) => c.number === n);
    return info && typeof info.overlord === "number" ? info.overlord : undefined;
  }
  function collapseSubjects(numbers) {
    return LlamaScore.excludeSubjectsOfPresentOverlords(
      numbers,
      (n) => (playerCountryNums.has(n) ? undefined : overlordOf(n)),
      numbers
    );
  }
  return (latestSnapshot.wars || [])
    .filter((w) => !w.concluded)
    .map((w) => {
      const attackerNums = collapseSubjects((w.sides && w.sides.Attacker) || []);
      const defenderNums = collapseSubjects((w.sides && w.sides.Defender) || []);
      const attackers = attackerNums.map((n) => countryLabel(countries, latestSnapshot.playerCountries, n));
      const defenders = defenderNums.map((n) => countryLabel(countries, latestSnapshot.playerCountries, n));
      const isPvP = attackers.some((a) => playerCountryNums.has(a.number)) && defenders.some((d) => playerCountryNums.has(d.number));
      return { warNumber: w.number, startDate: w.startDate, warName: w.warName || null, attackers, defenders, isPvP };
    })
    .filter((w) => (mode === "pve" ? !w.isPvP : w.isPvP))
    .sort((a, b) => String(b.startDate || "").localeCompare(String(a.startDate || "")));
}

function buildModeView(snapshots, events, mode, hiddenPlayers) {
  const { rows, leaderboard, latestSnapshot, unscoreableCount } = LlamaScore.computeFromLedger(snapshots, events, {}, hiddenPlayers, mode);
  const { wars: concludedWars, playerWhitePeaceCount, aiWhitePeaceCount } = LlamaScore.summarizeWars(rows, mode);
  return {
    latestSnapshot,
    ongoingWars: buildOngoingWars(latestSnapshot, mode),
    concludedWars,
    leaderboard,
    unscoreableCount,
    whitePeaceCount: mode === "pve" ? aiWhitePeaceCount : playerWhitePeaceCount,
  };
}

function pushUpdate() {
  // Guards against the renderer's did-finish-load firing (page loads in a
  // couple hundred ms) before initRecorder()'s first await resolves (parsing
  // real autosaves can take a few seconds) - config/state aren't set yet in
  // that window. The first real tick() call fires pushUpdate again once
  // they are, so nothing is lost by skipping this one.
  if (!mainWindow || !config || !state) return;
  const campaignKey = currentCampaignKey();
  let payload = {
    config: { saveDir: config.saveDir, dataDir: config.dataDir },
    campaignKey,
    isPinned: !!pinnedCampaignKey,
    lastError,
    log: logLines.slice(-100),
  };
  if (campaignKey) {
    const { snapshots, events } = readCampaignLedger(campaignKey);
    const hiddenPlayers = readHiddenPlayers(campaignKey);
    // "Every automation flag enabled at once" (see js/llama-score.js's
    // isFullyAutomated/computeAutomationDepartures) is a fully-automatic
    // departure signal, confirmed against real data - merged in alongside
    // the manual/shared hidden-players.json list (which wins on conflict,
    // since an explicit human choice should never be silently overridden by
    // an inferred one). No IPC/file write involved - purely computed fresh
    // from the ledger every tick.
    for (const [name, date] of LlamaScore.computeAutomationDepartures(snapshots)) {
      if (!hiddenPlayers.has(name)) hiddenPlayers.set(name, date);
    }
    // computeFromLedger/summarizeWars are called twice (once per mode) -
    // each call is independent/pure, so this is simply "score the same
    // ledger data twice under a different filter", not a duplicated recorder
    // scan or a second read of the files. latestSnapshot is identical either
    // way (it's derived from the snapshots themselves, not mode-dependent) -
    // taken from the pvp call for the header line.
    const pvp = buildModeView(snapshots, events, "pvp", hiddenPlayers);
    const pve = buildModeView(snapshots, events, "pve", hiddenPlayers);
    const latestSnapshot = pvp.latestSnapshot;
    // latestSnapshot itself (hundreds of countries' worth of data) is only
    // needed internally to build ongoingWars above - stripped before it goes
    // over IPC so the renderer isn't handed the full snapshot twice.
    delete pvp.latestSnapshot;
    delete pve.latestSnapshot;
    payload = Object.assign(payload, {
      playthroughName: latestSnapshot && latestSnapshot.playthroughName,
      date: latestSnapshot && latestSnapshot.date,
      capturedAt: latestSnapshot && latestSnapshot.capturedAt,
      snapshotCount: snapshots.length,
      eventCount: events.length,
      pvp,
      pve,
    });
  }
  mainWindow.webContents.send("llama:update", payload);
}

// --- window + IPC ---

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    icon: path.join(__dirname, "assets", "llama-logo.ico"),
    backgroundColor: "#12161c",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.webContents.once("did-finish-load", pushUpdate);
}

ipcMain.handle("campaigns:list", () => listCampaigns());

ipcMain.handle("campaigns:select", (_event, campaignKey) => {
  pinnedCampaignKey = campaignKey || null; // falsy (null/"") = back to auto/latest
  pushUpdate();
  return true;
});

// Separates an EXPLICIT override (only ever set by the user actually typing/
// picking a different folder) from the auto-computed default, so the
// Settings dialog can show the default as a placeholder/hint instead of a
// real value that gets blindly re-saved as if it were an explicit choice
// (see settings:save below and buildConfig's cachedDataDirValid comment -
// that round-trip is what used to permanently pin a since-deleted folder).
ipcMain.handle("settings:get", () => {
  const settings = loadSettings();
  return {
    saveDir: settings.saveDir || "",
    dataDir: settings.dataDir || "",
    defaultSaveDir: Recorder.DEFAULT_CONFIG.saveDir,
    defaultDataDir: defaultDataDir(),
  };
});

ipcMain.handle("settings:save", async (_event, incoming) => {
  const settings = loadSettings();
  // An empty field means "use the automatic default" - clear any previously
  // saved override instead of writing the empty string itself, so this
  // install (and any future one) keeps following its own fresh
  // defaultDataDir() rather than getting pinned to whatever happened to be
  // on screen when Save was clicked.
  for (const key of ["saveDir", "dataDir"]) {
    const value = typeof incoming[key] === "string" ? incoming[key].trim() : "";
    if (value) settings[key] = value;
    else delete settings[key];
  }
  saveSettingsToDisk(settings);
  await restartRecorder();
  return true;
});

ipcMain.handle("dialog:pick-folder", async (_event, defaultPath) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    defaultPath: defaultPath || undefined,
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle("shell:open-path", (_event, targetPath) => shell.openPath(targetPath));

// Marks `name` departed as of the CURRENT campaign's latest known in-game
// date (state.lastDateByCampaign, already tracked by the recorder for other
// purposes - no need to re-derive it from the ledger here) - see the
// hidden-players.json comment above for why this can't be a fully automatic
// detection. Applies to whichever campaign is actually being viewed right
// now (respects the Campaign picker's pin), not necessarily the one the
// recorder is live-scanning.
ipcMain.handle("players:hide", (_event, name) => {
  const campaignKey = currentCampaignKey();
  if (!campaignKey || !name) return false;
  const hidden = readHiddenPlayers(campaignKey);
  hidden.set(name, (state.lastDateByCampaign && state.lastDateByCampaign[campaignKey]) || null);
  writeHiddenPlayers(campaignKey, hidden);
  pushUpdate();
  return true;
});

ipcMain.handle("players:unhide", (_event, name) => {
  const campaignKey = currentCampaignKey();
  if (!campaignKey || !name) return false;
  const hidden = readHiddenPlayers(campaignKey);
  hidden.delete(name);
  writeHiddenPlayers(campaignKey, hidden);
  pushUpdate();
  return true;
});

app.whenReady().then(async () => {
  createWindow();
  await initRecorder();
  await tick();
  startPolling();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (pollTimer) clearInterval(pollTimer);
  if (process.platform !== "darwin") app.quit();
});
