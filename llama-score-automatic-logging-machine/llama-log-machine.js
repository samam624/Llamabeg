#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const zlib = require("zlib");
const { Worker } = require("worker_threads");

const Clausewitz = require("../js/clausewitz.js");
const ClausewitzBinary = require("../js/clausewitz-binary.js");
const MODIFIER_STATE_SCHEMA_VERSION = 5;

const DEFAULT_CONFIG = {
  saveDir: path.join(os.homedir(), "Documents", "Paradox Interactive", "Europa Universalis V", "save games"),
  dataDir: "./data",
  // Lowered from 15000: at high game speed the autosave rotation can cycle
  // through all ~9-10 slots in well under 90 seconds (confirmed on a real
  // session - all slots overwritten within about a minute), and each poll
  // only reads whatever autosaves currently exist on disk - one this slow
  // risked a save rotating away again before the next poll ever looked at
  // it. Each file only takes ~2.3s to parse (well within a rotation
  // interval this fast), so the bottleneck was purely how often scan() got
  // called, not how fast it ran once called.
  pollMs: 5000,
  stableMs: 2500,
  checkpointYears: 10,
  archiveFullSaves: false,
  autosavePattern: "^autosave_.*\\.eu5$",
  campaignMode: "latest",
  campaignKey: null,
  playerWarsOnly: true,
  storeAllEconomyCountries: false,
  // A snapshot arriving this many YEARS ahead of the last one tracked for
  // its campaign is quarantined instead of trusted - see the anomaly guard
  // in processParsedFile(). Real observed autosave cadence never exceeds
  // ~1-1.5 years between consecutive snapshots even at high game speed, so
  // this stays generous (never false-positives on genuine continuous play)
  // while still well below a jump big enough to corrupt war tracking (a
  // real 48-year jump - reloading an old save to test something in
  // singleplayer, which reuses the same autosave filename/campaign key -
  // produced 3 bogus war-start events and 1 false war-disappeared event
  // before this guard existed).
  maxForwardYearGap: 5,
};

function usage() {
  return [
    "🪓 Llama Score Logging Machine",
    "",
    "Usage:",
    "  node llama-log-machine.js --save-dir \"C:\\\\path\\\\to\\\\EU5\\\\save games\"",
    "  node llama-log-machine.js --config config.json",
    "",
    "Options:",
    "  --save-dir <dir>   Folder containing EU5 saves.",
    "  --data-dir <dir>   Output folder for JSONL ledgers and archive.",
    "  --campaign <id>    Watch one autosave campaign UUID.",
    "  --all-campaigns    Process every autosave campaign in the folder.",
    "  --once             Process current autosaves once, then exit.",
    "  --config <file>    JSON config file.",
    "",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { once: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--once") args.once = true;
    else if (a === "--all-campaigns") args.campaignMode = "all";
    else if (a === "--campaign") {
      args.campaignMode = "specific";
      args.campaignKey = argv[++i];
    }
    else if (a === "--save-dir") args.saveDir = argv[++i];
    else if (a === "--data-dir") args.dataDir = argv[++i];
    else if (a === "--config") args.config = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function readConfig(args) {
  let fileConfig = {};
  let configBase = __dirname;
  if (args.config) {
    const configPath = path.resolve(process.cwd(), args.config);
    configBase = path.dirname(configPath);
    fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  }
  const config = { ...DEFAULT_CONFIG, ...fileConfig };
  const saveDirBase = args.saveDir ? process.cwd() : configBase;
  const dataDirBase = args.dataDir ? process.cwd() : configBase;
  if (args.saveDir) config.saveDir = args.saveDir;
  if (args.dataDir) config.dataDir = args.dataDir;
  if (args.campaignMode) config.campaignMode = args.campaignMode;
  if (args.campaignKey) config.campaignKey = args.campaignKey;
  config.saveDir = path.resolve(saveDirBase, config.saveDir);
  config.dataDir = path.resolve(dataDirBase, config.dataDir);
  config.campaignsDir = path.join(config.dataDir, "campaigns");
  config.autosaveRegex = new RegExp(config.autosavePattern, "i");
  return config;
}

// Campaign keys come from campaignKeyFromFile() - normally an autosave UUID,
// filesystem-safe as-is, but sanitized defensively since it also accepts a
// bare non-"autosave_" filename (--campaign can be pointed at anything).
function safeCampaignKey(campaignKey) {
  return String(campaignKey || "unknown").replace(/[^\w.-]+/g, "_");
}

function campaignDir(config, campaignKey) {
  return path.join(config.campaignsDir, safeCampaignKey(campaignKey));
}

function campaignSnapshotsFile(config, campaignKey) {
  return path.join(campaignDir(config, campaignKey), "snapshots.jsonl");
}

function campaignEventsFile(config, campaignKey) {
  return path.join(campaignDir(config, campaignKey), "war-events.jsonl");
}

// Where a snapshot goes when the forward-jump anomaly guard (see
// processParsedFile) quarantines it instead of trusting it - same JSONL
// format as snapshots.jsonl (each line is a full snapshot object, plus an
// `anomalyReason` field), just kept out of the file every other consumer
// (js/llama-score.js, the web app's ledger-connect.js, the desktop
// dashboard) already reads. Nothing is ever silently discarded - see
// tools/campaign-ledger-doctor.js's `promote` command to pull an entry back
// into the real ledger if a flagged jump turns out to have been intentional.
function campaignAnomaliesFile(config, campaignKey) {
  return path.join(campaignDir(config, campaignKey), "anomalies.jsonl");
}

function campaignArchiveDir(config, campaignKey) {
  return path.join(campaignDir(config, campaignKey), "archive");
}

// --- gzip compaction, so a campaign's ledger shrinks ~13-18x once it's no
// longer being actively played (real JSONL is highly repetitive - same field
// names/structure every line - so it compresses far better than typical
// binary data). A campaign folder holds EITHER the plain "<name>.jsonl" OR
// its compacted "<name>.jsonl.gz" twin, never both at once - every reader
// below (readLedgerText/statLedgerFile) checks plain first, falls back to
// .gz, so the distinction is invisible to every consumer of this data.

function ledgerGzFile(plainFile) {
  return plainFile + ".gz";
}

// Reads a ledger file's content whether it's currently plain or gzip-
// compacted. Returns "" if neither exists (never having recorded anything
// for this campaign yet is a normal, common state, not an error).
function readLedgerText(plainFile) {
  if (fs.existsSync(plainFile)) return fs.readFileSync(plainFile, "utf8");
  const gzFile = ledgerGzFile(plainFile);
  if (fs.existsSync(gzFile)) return zlib.gunzipSync(fs.readFileSync(gzFile)).toString("utf8");
  return "";
}

// mtime/size of whichever form (plain or .gz) currently exists on disk - the
// Dashboard's readCampaignLedger() cache keys off this instead of assuming
// the plain file is always what's there.
function statLedgerFile(plainFile) {
  if (fs.existsSync(plainFile)) return fs.statSync(plainFile);
  const gzFile = ledgerGzFile(plainFile);
  if (fs.existsSync(gzFile)) return fs.statSync(gzFile);
  return null;
}

// Compresses a campaign's snapshots.jsonl/war-events.jsonl to .gz and
// removes the plain originals - safe to call on ANY campaign that isn't
// being appended to THIS tick (see scan()'s call site, which only ever
// compacts campaigns outside the set just processed this run). Idempotent:
// a campaign with no plain file (never recorded, or already compacted) is a
// no-op. Writes to a .tmp file and renames over the target so a crash
// mid-write can never leave a half-written .gz on disk - worst case, the
// next tick just finds the plain file still there and tries again.
function compactCampaignLedger(config, campaignKey) {
  for (const plainFile of [campaignSnapshotsFile(config, campaignKey), campaignEventsFile(config, campaignKey)]) {
    if (!fs.existsSync(plainFile)) continue;
    const gzFile = ledgerGzFile(plainFile);
    const tmpFile = gzFile + ".tmp";
    fs.writeFileSync(tmpFile, zlib.gzipSync(fs.readFileSync(plainFile), { level: 9 }));
    fs.renameSync(tmpFile, gzFile);
    fs.unlinkSync(plainFile);
  }
}

// Reverses compactCampaignLedger - called before appending to a campaign
// that might have been compacted (e.g. the user resumed a campaign that
// hadn't seen a new autosave in a while). Gzip can't be appended to in
// place, so this decompresses back to plain text first; the very next
// appendJsonl() call then works exactly as it always has. A no-op if the
// campaign was never compacted (or never recorded) in the first place.
function decompactCampaignLedger(config, campaignKey) {
  for (const plainFile of [campaignSnapshotsFile(config, campaignKey), campaignEventsFile(config, campaignKey)]) {
    if (fs.existsSync(plainFile)) continue;
    const gzFile = ledgerGzFile(plainFile);
    if (!fs.existsSync(gzFile)) continue;
    fs.writeFileSync(plainFile, zlib.gunzipSync(fs.readFileSync(gzFile)));
    fs.unlinkSync(gzFile);
  }
}

// One-time upgrade path: earlier versions of this recorder appended every
// campaign into one shared data/snapshots.jsonl + data/war-events.jsonl,
// which meant scoring one campaign in the analyzer required loading (and the
// analyzer silently filtering out) every other campaign ever recorded - slow
// and, worse, actively corrupted "latest snapshot"/player-attribution logic
// when an unrelated campaign happened to sort as more recent. Split any
// legacy files found into per-campaign bins under data/campaigns/<key>/, the
// same layout new snapshots are written to below, then move the originals
// aside so this only runs once.
function migrateLegacyLedgerIfNeeded(config) {
  const legacySnapshots = path.join(config.dataDir, "snapshots.jsonl");
  const legacyEvents = path.join(config.dataDir, "war-events.jsonl");
  if (!fs.existsSync(legacySnapshots) && !fs.existsSync(legacyEvents)) return;

  console.log("Found legacy single-file ledger - migrating to per-campaign bins...");
  const sourceHashToCampaign = new Map();
  const snapshotLinesByCampaign = new Map();

  if (fs.existsSync(legacySnapshots)) {
    for (const line of fs.readFileSync(legacySnapshots, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let snapshot;
      try {
        snapshot = JSON.parse(line);
      } catch {
        continue; // Drop a truncated/corrupt line rather than fail the whole migration.
      }
      const key = snapshot.campaignKey || "unknown";
      if (!snapshotLinesByCampaign.has(key)) snapshotLinesByCampaign.set(key, []);
      snapshotLinesByCampaign.get(key).push(line);
      if (snapshot.sourceHash) sourceHashToCampaign.set(snapshot.sourceHash, key);
    }
    for (const [key, lines] of snapshotLinesByCampaign.entries()) {
      ensureDir(campaignDir(config, key));
      fs.writeFileSync(campaignSnapshotsFile(config, key), lines.join("\n") + "\n");
    }
  }

  let eventCampaignCount = 0;
  if (fs.existsSync(legacyEvents)) {
    const eventLinesByCampaign = new Map();
    for (const line of fs.readFileSync(legacyEvents, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      // war-events.jsonl doesn't carry campaignKey directly - trace it back
      // through the snapshot that produced the event (same sourceHash).
      const key = sourceHashToCampaign.get(event.sourceHash) || "unknown";
      if (!eventLinesByCampaign.has(key)) eventLinesByCampaign.set(key, []);
      eventLinesByCampaign.get(key).push(line);
    }
    eventCampaignCount = eventLinesByCampaign.size;
    for (const [key, lines] of eventLinesByCampaign.entries()) {
      ensureDir(campaignDir(config, key));
      fs.writeFileSync(campaignEventsFile(config, key), lines.join("\n") + "\n");
    }
  }

  const legacyDir = path.join(config.dataDir, "legacy");
  ensureDir(legacyDir);
  if (fs.existsSync(legacySnapshots)) fs.renameSync(legacySnapshots, path.join(legacyDir, "snapshots.jsonl"));
  if (fs.existsSync(legacyEvents)) fs.renameSync(legacyEvents, path.join(legacyDir, "war-events.jsonl"));

  console.log(
    `Migrated ${snapshotLinesByCampaign.size} campaign(s) (snapshots) / ${eventCampaignCount} campaign(s) (events) into ${config.campaignsDir}. ` +
      `Originals moved to ${legacyDir}.`
  );
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// Only ever used for state.json - a machine-only cache nobody hand-edits,
// unlike config.json - so compact (no pretty-print indentation) is strictly
// better: measured ~40% smaller and ~25% faster to write on a real 750KB
// state.json than the old `null, 2` pretty-printed form, for zero behavior
// change. See pruneStaleCampaignState() below for the other, bigger half of
// this fix (most of that 750KB was dead weight from old campaigns).
function saveJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
}

function appendJsonl(file, value) {
  fs.appendFileSync(file, JSON.stringify(value) + "\n");
}

function dateParts(date) {
  if (!date || typeof date !== "string") return { year: null };
  const m = date.match(/^(\d+)/);
  return { year: m ? Number(m[1]) : null };
}

function dateKey(date) {
  if (!date || typeof date !== "string") return null;
  const parts = date.split(".").map((p) => Number(p));
  if (!parts.length || parts.some((p) => !Number.isFinite(p))) return null;
  while (parts.length < 4) parts.push(0);
  return parts[0] * 100000000 + parts[1] * 1000000 + parts[2] * 10000 + parts[3];
}

function compareDates(a, b) {
  const ak = dateKey(a);
  const bk = dateKey(b);
  if (ak === null && bk === null) return 0;
  if (ak === null) return -1;
  if (bk === null) return 1;
  return ak - bk;
}

function campaignKeyFromFile(file) {
  const name = path.basename(file);
  const m = name.match(/^autosave_(.+?)(?:_\d+)?\.eu5$/i);
  return m ? m[1] : name.replace(/\.eu5$/i, "");
}

function tryStat(file) {
  try {
    return fs.statSync(file);
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "EPERM" || err.code === "EBUSY")) return null;
    throw err;
  }
}

function isStable(file, stableMs) {
  const a = tryStat(file);
  if (!a) return false;
  const age = Date.now() - a.mtimeMs;
  if (age < stableMs) return false;
  return a.size > 0;
}

function listAutosaves(config) {
  if (!fs.existsSync(config.saveDir)) return [];
  const entries = [];
  for (const d of fs.readdirSync(config.saveDir, { withFileTypes: true })) {
    if (!d.isFile() || !config.autosaveRegex.test(d.name)) continue;
    const file = path.join(config.saveDir, d.name);
    const stat = tryStat(file);
    if (stat) entries.push({ file, stat });
  }

  if (config.campaignMode === "all") return entries;
  if (config.campaignMode === "specific" && config.campaignKey) {
    return entries.filter((entry) => campaignKeyFromFile(entry.file) === config.campaignKey);
  }

  let newest = null;
  for (const entry of entries) {
    const key = campaignKeyFromFile(entry.file);
    if (!newest || entry.stat.mtimeMs > newest.mtimeMs) newest = { key, mtimeMs: entry.stat.mtimeMs };
  }
  return newest ? entries.filter((entry) => campaignKeyFromFile(entry.file) === newest.key) : [];
}

async function readAndParseSave(file, config) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "EPERM" || err.code === "EBUSY")) {
      const e = new Error("save rotated or locked during scan");
      e.code = err.code;
      throw e;
    }
    throw err;
  }
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const header = bytes.subarray(0, 7);
  const headerText = header.toString("utf8");
  if (!headerText.startsWith("SAV")) throw new Error("Not an EU5 save file");
  const formatCode = headerText.slice(5, 7);

  // includeLocations is needed even though this recorder has no use for map
  // data itself - it's what lets reconcileWarOccupation() (in
  // js/clausewitz.js, shared by both parsers) recompute each war's
  // occupation from the real, live location CONTROLLER instead of the war
  // entry's own (frozen, ownership-based - see extractWarFields' comment)
  // locations map. Confirmed on real data: without this, the win/loss
  // heuristic was reading who owned a war's contested provinces *before*
  // the war even started, not who was actually winning it - wrong on every
  // war checked in one real campaign. Measured overhead: ~10% (running the
  // full location extraction over ~28,500 locations costs about 220ms on
  // top of an already ~2.3s parse), acceptable for a recorder that only
  // runs once per new autosave.
  if (formatCode === "00") {
    const text = bytes.toString("utf8");
    return {
      hash,
      result: Clausewitz.parseSave(text, {
        includeWars: true,
        includeLocations: true,
        includeModifierState: true,
        playerWarsOnly: !!config.playerWarsOnly,
      }),
    };
  }

  if (formatCode === "03") {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return {
      hash,
      result: await ClausewitzBinary.parseCompressedSave(buffer, {
        includeWars: true,
        includeLocations: true,
        includeModifierState: true,
        playerWarsOnly: !!config.playerWarsOnly,
      }),
    };
  }

  throw new Error(`Unsupported save format code ${formatCode}`);
}

// overlordOf (a Map<subjectNumber, overlordNumber> built from
// result.dependencies - see extractDependencyFields in js/clausewitz.js)
// lets the Llama/Alpaca Score engine tell a war's real sovereign
// belligerents apart from vassals/subjects dragged along for the ride -
// see excludeSubjectsOfPresentOverlords() in js/llama-score.js for why that
// matters for PVE scoring specifically.
// `includeLocations` attaches the actual owned-location-ID array (not just
// its count) - used by sideEconomyDeltas below to tell a real land loss to
// an enemy apart from an internal transfer to one of the player's own
// vassals that happened to land at the same moment. Deliberately NOT
// unconditional: buildSnapshot() only passes true for its bounded
// `interestingCountries` set (players, war participants, and their
// vassals - typically dozens of countries, not the full ~2000+ roster), so
// this can't bloat the ledger the way attaching it to every country would.
// `includeAutomation` attaches the country's automated_systems array (see
// js/clausewitz.js's comment for the real-data finding behind this) - only
// meaningful/needed for player-controlled countries (buildSnapshot() only
// passes true when building playerCountries below), and cheap regardless
// (a handful of short strings, not hundreds of numeric IDs like
// ownedLocations - no bounding concern here).
function countrySummary(c, overlordOf, includeLocations, includeAutomation) {
  const overlord = overlordOf ? overlordOf.get(c.number) : undefined;
  const summary = {
    number: c.number,
    tag: c.tag,
    players: c.players || [],
    gold: c.gold,
    prestige: c.prestige,
    income: c.income,
    expense: c.expense,
    lastMonthGoldIncome: c.lastMonthGoldIncome,
    creditworthiness: c.creditworthiness,
    loanCapacity: c.loanCapacity,
    // Total outstanding loan principal (js/clausewitz.js's/clausewitz-
    // binary.js's attachCountryDebt(), summed from loan_manager.database) -
    // used to net loan proceeds/repayments out of the treasury-swing signal
    // below (sideEconomyDeltas) so taking out a loan doesn't look like
    // winning gold, and repaying one doesn't look like losing it.
    totalDebt: c.totalDebt,
    gpRank: c.greatPowerRank,
    scorePlace: c.scorePlace,
    locationCount: c.locationCount,
    capital: c.capital,
    overlord: typeof overlord === "number" ? overlord : null,
  };
  if (includeLocations) summary.ownedLocations = Array.isArray(c.ownedLocations) ? c.ownedLocations : [];
  if (includeAutomation) summary.automatedSystems = Array.isArray(c.automatedSystems) ? c.automatedSystems : [];
  if (includeAutomation && c.modifierState) summary.modifierState = c.modifierState;
  return summary;
}

function buildOverlordLookup(result) {
  const map = new Map();
  for (const dep of result.dependencies || []) {
    if (typeof dep.overlord === "number" && typeof dep.subject === "number") map.set(dep.subject, dep.overlord);
  }
  return map;
}

// Compact country-state facts used by the societal-value equilibrium
// report. The game's centralization pressure treats missing per-location
// control as zero and averages across every owned location; this exact
// denominator reproduces HUN's in-game 26.53 equilibrium on 1337.6.1.
function societalDynamicFacts(country, result) {
  const owned = Array.isArray(country.ownedLocations) ? country.ownedLocations : [];
  const ownedSet = new Set(owned);
  let developmentTotal = 0;
  let controlTotal = 0;
  let ownedPopulation = 0;
  let weightedLiteracy = 0;
  let stateReligionClergy = 0;
  let primaryReligionPopulation = 0;
  let acceptedCultureNobles = 0;
  let primaryCultureNobles = 0;
  const populationByType = {};
  const acceptedCultures = new Set([country.primaryCulture].concat(
    country.modifierState && Array.isArray(country.modifierState.acceptedCultures)
      ? country.modifierState.acceptedCultures
      : []
  ));
  const ownedPopIds = new Set();
  for (const location of result.locations || []) {
    if (!ownedSet.has(location.number)) continue;
    if (typeof location.development === "number") developmentTotal += location.development;
    if (typeof location.control === "number") controlTotal += location.control;
    for (const popId of location.popIds || []) ownedPopIds.add(popId);
  }
  for (const pop of result.popRecords || []) {
    if (!ownedPopIds.has(pop.number) || typeof pop.size !== "number") continue;
    ownedPopulation += pop.size;
    populationByType[pop.type] = (populationByType[pop.type] || 0) + pop.size;
    if (typeof pop.literacy === "number") weightedLiteracy += pop.size * pop.literacy;
    if (pop.religion === country.primaryReligion) primaryReligionPopulation += pop.size;
    if (pop.type === "clergy" && pop.religion === country.primaryReligion) stateReligionClergy += pop.size;
    if (pop.type === "nobles" && acceptedCultures.has(pop.culture)) acceptedCultureNobles += pop.size;
    if (pop.type === "nobles" && pop.culture === country.primaryCulture) primaryCultureNobles += pop.size;
  }
  const subjectTypeCounts = {};
  for (const dependency of result.dependencies || []) {
    if (dependency.overlord !== country.number || typeof dependency.subjectType !== "string") continue;
    subjectTypeCounts[dependency.subjectType] = (subjectTypeCounts[dependency.subjectType] || 0) + 1;
  }
  let atWar = false;
  for (const war of result.wars || []) {
    const status = String(war.status || "").toLowerCase();
    if (status === "ended" || status === "concluded" || status === "inactive") continue;
    if ((war.participants || []).some((participant) => participant.country === country.number && !participant.leaveDate)) {
      atWar = true;
      break;
    }
  }
  const state = country.modifierState || {};
  let estateTradeIncome = 0;
  for (const entry of result.estateTradeIncomes || []) {
    if (entry.country === country.number && typeof entry.tradeIncome === "number") estateTradeIncome += entry.tradeIncome;
  }
  return {
    averageOwnedLocationDevelopment: owned.length ? developmentTotal / owned.length : 0,
    averageOwnedLocationControl: owned.length ? controlTotal / owned.length : 0,
    ownedPopulation,
    averageLiteracy: ownedPopulation ? weightedLiteracy / ownedPopulation : 0,
    stateReligionClergyShare: ownedPopulation ? stateReligionClergy / ownedPopulation : 0,
    primaryReligionShare: ownedPopulation ? primaryReligionPopulation / ownedPopulation : 0,
    acceptedCultureNoblesShare: ownedPopulation ? acceptedCultureNobles / ownedPopulation : 0,
    primaryCultureNoblesShare: ownedPopulation ? primaryCultureNobles / ownedPopulation : 0,
    populationShares: Object.fromEntries(Object.entries(populationByType).map(([type, size]) => [type, ownedPopulation ? size / ownedPopulation : 0])),
    armyTradition: typeof country.armyTradition === "number" ? country.armyTradition : 0,
    atWar,
    maintenances: state.maintenances || {},
    characterTraits: state.characterTraits || {},
    employmentSystem: state.employmentSystem || "first_come_first_serve",
    countryArtShare: typeof state.countryArtShare === "number" ? state.countryArtShare : 0,
    countryArtQualityShare: typeof state.countryArtQualityShare === "number" ? state.countryArtQualityShare : 0,
    historicalTaxBase: Array.isArray(country.historicalTaxBase) && typeof country.historicalTaxBase.at(-1) === "number" ? country.historicalTaxBase.at(-1) : null,
    historicalEconomicBase: Array.isArray(country.historicalEconomicalBase) && typeof country.historicalEconomicalBase.at(-1) === "number" ? country.historicalEconomicalBase.at(-1) : null,
    estateTradeIncome,
    subjectTypeCounts,
  };
}

function allCountryLookup(countries, overlordOf) {
  const lookup = {};
  for (const c of countries || []) {
    if (typeof c.number === "number") lookup[c.number] = countrySummary(c, overlordOf);
  }
  return lookup;
}

function participantSummary(p) {
  return {
    country: p.country,
    side: p.side,
    reason: p.reason,
    calledAlly: p.calledAlly,
    revolter: !!p.revolter,
    joinDate: p.joinDate,
    leaveDate: p.leaveDate,
    combat: p.combat,
    siege: p.siege,
    status: p.status,
    // Per-country battle/attrition/capture casualties (js/clausewitz.js's
    // extractWarFields) - lets the scoring engine tell "actually fought"
    // apart from "joined then left without a single battle" per participant
    // (js/llama-score.js's hasFoughtLosses()), which the war-wide
    // attacker_losses/defender_losses aggregate can't do.
    losses: p.losses,
  };
}

function participantSummariesWithSides(war) {
  const participants = (war.participants || []).map(participantSummary);
  const sideByCountry = new Map();
  if (typeof war.originalAttacker === "number") sideByCountry.set(war.originalAttacker, "Attacker");
  for (const c of war.originalDefenders || []) sideByCountry.set(c, "Defender");
  for (const p of participants) {
    if (p.side === "Attacker" || p.side === "Defender") sideByCountry.set(p.country, p.side);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const p of participants) {
      if (sideByCountry.has(p.country)) continue;
      if (sideByCountry.has(p.calledAlly)) {
        sideByCountry.set(p.country, sideByCountry.get(p.calledAlly));
        changed = true;
      }
    }
  }

  for (const p of participants) {
    p.side = sideByCountry.get(p.country) || p.side || null;
  }
  return participants;
}

// A "Declined" participant was invited/targeted (present in
// war.participants, often even in originalAttacker/originalDefenders) but
// never actually joined the fight - confirmed on real data: a country
// listed as an original Target with status "Declined" had a DIFFERENT
// country join in its place as a called-ally instead. Excluded here (not
// just left in "Other") so it never counts as a real belligerent for
// scoring or war.sides - real user-reported bug this closes: a declined-
// but-listed country's tag showed up as if it were fighting in TWO
// different wars at once (impossible in EU5), when it was never really in
// the first one at all.
function countriesBySide(participants) {
  const sides = { Attacker: [], Defender: [], Other: [] };
  for (const p of participants || []) {
    if (p.status === "Declined") continue;
    const side = p.side === "Attacker" || p.side === "Defender" ? p.side : "Other";
    sides[side].push(p.country);
  }
  sides.Attacker = [...new Set(sides.Attacker)];
  sides.Defender = [...new Set(sides.Defender)];
  sides.Other = [...new Set(sides.Other)];
  return sides;
}

function numDelta(after, before) {
  return typeof after === "number" && typeof before === "number" ? after - before : null;
}

// Real per-location diff when both snapshots carry the actual ID arrays
// (`ownedLocations` - see js/clausewitz.js and countrySummary() above, only
// populated for the bounded `interestingCountries` set) instead of just a
// before/after COUNT. Real user-reported bug this fixes: a player internally
// transferred land to one of their own vassals right before an autosave
// landed, at the same moment a war concluded - the old count-only delta saw
// the player's own locationCount drop and read it as a war loss, when none
// of that land actually went to the enemy. Checks every "lost" location
// (present in `before`, absent from `after`) against every vassal's OWN
// `ownedLocations` in the same after-snapshot (`.overlord === country`) and
// drops it from the loss tally if a vassal has it - an internal transfer,
// not a real loss. Falls back to the plain count delta when either side
// lacks the array (older ledger data recorded before this existed, or a
// country outside the bounded set) - same graceful-degradation pattern as
// every other data-availability caveat in this file.
// Returns `{ value, gained, lost }` - `value` is the same net number this
// always returned, `gained`/`lost` are the actual location ID arrays behind
// it (null when falling back to the plain count, since there's nothing real
// to list) - lets a war's real land exchange be inspected directly instead
// of just trusting a net number, per the user's explicit request.
function locationSetDelta(country, before, after, vanished, afterCountries) {
  const fallback = () => ({ value: vanished ? -before.locationCount : numDelta(after && after.locationCount, before.locationCount), gained: null, lost: null });
  const beforeIds = Array.isArray(before.ownedLocations) ? before.ownedLocations : null;
  if (!beforeIds) return fallback();
  // A vanished country owns nothing afterward, by definition - an empty
  // array is exactly the right "after" state to diff against (everything it
  // had is `lost`, nothing `gained`).
  const afterIds = vanished ? [] : after && Array.isArray(after.ownedLocations) ? after.ownedLocations : null;
  if (!afterIds) return fallback();
  const afterSet = new Set(afterIds);
  const beforeSet = new Set(beforeIds);
  const gained = afterIds.filter((id) => !beforeSet.has(id));
  let lost = beforeIds.filter((id) => !afterSet.has(id));
  const vassalOwned = new Set();
  for (const info of Object.values(afterCountries)) {
    if (info && info.overlord === country && Array.isArray(info.ownedLocations)) {
      for (const id of info.ownedLocations) vassalOwned.add(id);
    }
  }
  lost = lost.filter((id) => !vassalOwned.has(id));
  return { value: gained.length - lost.length, gained, lost };
}

function sideEconomyDeltas(war, beforeCountries, afterCountries) {
  if (!war || !beforeCountries || !afterCountries) return null;
  const sides = war.sides || countriesBySide(war.participants || []);
  const originalPrincipals = {
    Attacker: typeof war.originalAttacker === "number" ? new Set([war.originalAttacker]) : new Set(),
    Defender: new Set((war.originalDefenders || []).filter((n) => typeof n === "number")),
  };
  const result = {};
  for (const side of ["Attacker", "Defender"]) {
    const countries = sides[side] || [];
    const entryByCountry = new Map();
    function entryFor(country) {
      let entry = entryByCountry.get(country);
      if (!entry) {
        entry = { country, goldDelta: null, prestigeDelta: null, locationDelta: null, locationsGained: null, locationsLost: null };
        entryByCountry.set(country, entry);
      }
      return entry;
    }
    for (const country of countries) {
      const before = beforeCountries[country];
      const after = afterCountries[country];
      if (!before) continue;
      // A full annexation (or any other total wipeout) removes the loser's
      // tag from the save entirely rather than leaving a locationCount:0
      // stub behind - confirmed on real data (a fully-annexed defender)
      // where `after` was simply absent even though buildSnapshot()
      // deliberately keeps tracking a just-concluded war's participants for
      // one more snapshot. Without this, the conquest's land transfer
      // silently vanished from the comparison instead of counting as a
      // total loss. Only locationCount is inferred as 0 here - a vanished
      // country's gold/prestige has no well-defined "transfer" the way its
      // province count does, so those stay null (no evidence) rather than
      // guessing.
      const vanished = !after && typeof before.locationCount === "number";
      if (!after && !vanished) continue;
      // Net OUT any change in outstanding debt from the raw treasury change -
      // taking a loan hands you gold AND an equal liability at the same
      // instant (no real gain), and repaying one removes both together (no
      // real loss). Confirmed on real data: a player's gold rose across a
      // war window purely from a fresh loan, which the old raw-gold check
      // read as "winning" the war economically. `debtDelta` is null (not 0)
      // when either snapshot predates totalDebt being recorded - falls back
      // to the un-netted raw delta in that case (old ledger data), same as
      // if debt simply hadn't changed, rather than losing the signal
      // entirely.
      const rawGoldDelta = after ? numDelta(after.gold, before.gold) : null;
      const debtDelta = after ? numDelta(after.totalDebt, before.totalDebt) : null;
      const goldDelta = typeof rawGoldDelta === "number" ? rawGoldDelta - (typeof debtDelta === "number" ? debtDelta : 0) : null;
      const prestigeDelta = after ? numDelta(after.prestige, before.prestige) : null;
      const locationResult = locationSetDelta(country, before, after, vanished, afterCountries);
      const entry = entryFor(country);
      entry.goldDelta = goldDelta;
      entry.prestigeDelta = prestigeDelta;
      entry.locationDelta = locationResult.value;
      entry.locationsGained = locationResult.gained;
      entry.locationsLost = locationResult.lost;
    }
    // A brand-new subject (present only in `after`, absent from `before`
    // entirely - a genuinely new tag, not a pre-existing nation that merely
    // changed overlords) whose overlord is one of THIS side's ORIGINAL
    // principal(s) - a real EU5 peace-deal choice (release conquered
    // provinces into a new vassal instead of keeping them) that otherwise
    // makes a decisive conquest invisible, since the principal's own
    // locationCount never moves. Confirmed on real data: Castile released
    // Portugal's ceded provinces into a brand-new vassal - Castile's own
    // locationCount was static the entire war (251->251) while the actual
    // 9-province conquest only ever showed up under the new vassal's own
    // tag, which buildSnapshot() now tracks specifically so this pass has
    // data to read. Folded directly into the PRINCIPAL's own locationDelta
    // (not a separate countryDeltas entry) so economicOutcomeSignal's
    // existing principal-only summation picks it up with no further changes
    // - restricted to location only, since a new subject's gold/prestige
    // isn't a comparable "gain" the same way its province count is.
    for (const numStr of Object.keys(afterCountries)) {
      const num = Number(numStr);
      if (beforeCountries[num]) continue;
      const info = afterCountries[numStr];
      if (typeof info.overlord !== "number" || !originalPrincipals[side].has(info.overlord)) continue;
      if (typeof info.locationCount !== "number" || info.locationCount === 0) continue;
      const entry = entryFor(info.overlord);
      entry.locationDelta = (typeof entry.locationDelta === "number" ? entry.locationDelta : 0) + info.locationCount;
    }
    const entries = [...entryByCountry.values()];
    let gold = 0;
    let prestige = 0;
    let locations = 0;
    let goldCount = 0;
    let prestigeCount = 0;
    let locationCount = 0;
    for (const entry of entries) {
      if (typeof entry.goldDelta === "number") {
        gold += entry.goldDelta;
        goldCount++;
      }
      if (typeof entry.prestigeDelta === "number") {
        prestige += entry.prestigeDelta;
        prestigeCount++;
      }
      if (typeof entry.locationDelta === "number") {
        locations += entry.locationDelta;
        locationCount++;
      }
    }
    result[side] = {
      countries,
      goldDelta: goldCount ? gold : null,
      prestigeDelta: prestigeCount ? prestige : null,
      locationDelta: locationCount ? locations : null,
      countryDeltas: entries,
    };
  }
  return result;
}

// Same principal-vs-coalition distinction as js/llama-score.js's copy of
// this function (kept in sync deliberately, see that file's comment on why
// this logic is duplicated rather than shared) - restricts a side's economy
// delta to just the war's ORIGINALLY-declared belligerent(s) before falling
// back to the full side aggregate, so a player fully annexing an unrelated
// coalition member mid-war can't swing the wrong side's "winner" call off a
// windfall against a third party while actually losing land to the real
// opposing player.
// `war.originalAttacker`/`war.originalDefenders` record who the game
// DECLARED as belligerents, not who actually showed up - a country invited/
// targeted but never joining (status "Declined") still appears here. Real
// bug found on real data: a declined defender's own (unrelated) location
// gain got summed together with the REAL defender's real location LOSS in
// the same principal set, netting to ~0 and masking a clean, decisive land
// transfer as a White Peace - the declined country was never actually
// fighting, so whatever else was happening to its territory that same month
// has nothing to do with this war. Excluded here so a Declined "principal"
// contributes nothing to any economic signal, the same way it's already
// excluded from the displayed participant lists (countriesBySide above).
function principalCountrySet(value, war) {
  const declined = new Set();
  if (war) for (const p of war.participants || []) if (p.status === "Declined") declined.add(p.country);
  const set = new Set();
  if (typeof value === "number") {
    if (!declined.has(value)) set.add(value);
  } else if (Array.isArray(value)) {
    for (const n of value) if (typeof n === "number" && !declined.has(n)) set.add(n);
  }
  return set;
}
// A vassal being attacked drags its Overlord into the war automatically
// (confirmed by the user from real play - "the overlord will auto take over
// if i attack a vassal") - the war's own participant list already records
// this: the Overlord's own participant entry has `reason === "Overlord"` and
// `calledAlly` pointing at the vassal it's defending. Looked up per-war (not
// from a country's current `.overlord` field, which only reflects
// present-day status) since that's the actual mechanic that pulled them in,
// self-contained in data already on the war object.
function overlordFor(war, vassalCountry) {
  const participants = war.participants || [];
  for (const p of participants) {
    if (p.reason === "Overlord" && p.calledAlly === vassalCountry) return p.country;
  }
  return null;
}
// Land can genuinely move to/from either the vassal (their own conquered
// provinces) or the Overlord (who negotiates the actual peace) - so the
// location-delta principal set is the UNION of both.
function principalsWithOverlords(base, war) {
  const expanded = new Set(base);
  for (const country of base) {
    const overlord = overlordFor(war, country);
    if (overlord != null) expanded.add(overlord);
  }
  // Downward direction too, not just upward: per the user's explicit call,
  // taking land from someone's VASSAL is winning against THEM - a subject
  // has no standing of its own, it's the same political entity as its
  // overlord. `reason === "Subject"` participants (real subjects, called in
  // specifically because they belong to a principal already in this set)
  // get folded in, transitively - a subject can itself have its own
  // subjects fighting too, confirmed real in an actual campaign war (a
  // 3-level chain). Deliberately does NOT pull in "InternationalOrganization"
  // or any other non-Subject call-in reason - those are genuinely separate
  // political entities dragged in by an alliance/league mechanic, not part
  // of the principal's own realm, and stay excluded per the original
  // coalition-vs-principal design - only a REAL subject counts here.
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of war.participants || []) {
      if (expanded.has(p.country) || p.status === "Declined") continue;
      if (p.reason === "Subject" && expanded.has(p.calledAlly)) {
        expanded.add(p.country);
        changed = true;
      }
    }
  }
  return expanded;
}
// Gold is different: per the user's call, "you can never exchange money with
// a vassal only with the overlord in a peace" - a vassal has no treasury
// standing of its own in a peace deal, so when a principal has an Overlord
// present, the Overlord REPLACES it for gold purposes rather than being
// added alongside it (unlike location, this is not a union).
function principalsForGold(base, war) {
  const result = new Set();
  for (const country of base) {
    const overlord = overlordFor(war, country);
    result.add(overlord != null ? overlord : country);
  }
  return result;
}
function principalFieldSum(sideInfo, principals, field) {
  if (!sideInfo || !sideInfo.countryDeltas || !principals.size) return null;
  let sum = 0;
  let count = 0;
  for (const cd of sideInfo.countryDeltas) {
    if (!principals.has(cd.country)) continue;
    if (typeof cd[field] === "number") {
      sum += cd[field];
      count++;
    }
  }
  return count ? sum : null;
}
function resolveSideField(sideInfo, principals, field) {
  const principalValue = principalFieldSum(sideInfo, principals, field);
  if (principalValue !== null) return { value: principalValue, usedPrincipal: true };
  return { value: sideInfo ? sideInfo[field] : null, usedPrincipal: false };
}
// Same principal-scoping as principalFieldSum, but for the actual location
// ID lists (locationsGained/locationsLost - see locationSetDelta) instead
// of the net number - lets a war's real land exchange be inspected directly
// rather than just trusting a spread. Union across every principal on the
// side. Null (not an empty array) when nothing in this side's principals
// carries it, so the UI can tell "no exchange" apart from "no data for this
// older war".
function principalFieldUnion(sideInfo, principals, field) {
  if (!sideInfo || !sideInfo.countryDeltas || !principals.size) return null;
  const ids = new Set();
  let any = false;
  for (const cd of sideInfo.countryDeltas) {
    if (!principals.has(cd.country)) continue;
    if (Array.isArray(cd[field])) {
      any = true;
      for (const id of cd[field]) ids.add(id);
    }
  }
  return any ? [...ids] : null;
}

// The single strongest signal available: an ENFORCED war-reparations
// obligation (diplomacy_manager's war_reparations - see js/clausewitz.js's
// extractWarReparationsFields) directly records who lost and who won,
// straight from the peace treaty itself - unlike land/gold deltas, it isn't
// INFERRED from noisy before/after snapshot comparisons, and it persists
// ~10 in-game years, far longer than war_manager keeps a concluded war's own
// record around (confirmed on real data: matching war-disappeared events
// for these exact wars had already been purged from war_manager by the time
// the corresponding autosave was captured, yet the reparations record was
// still sitting in diplomacy_manager). "first"/payer is the war's LOSER,
// "second"/receiver is the WINNER - confirmed against a real save's already-
// independently-validated outcome (England collecting from Castile), not
// assumed. Uses the same gold-principal substitution as the treasury-swing
// signal (a vassal has no treasury standing in a peace, so its Overlord is
// who actually pays/collects), and only considers an obligation that started
// on or after this war's own start date - one from years earlier between the
// same two countries would be a leftover from a DIFFERENT war.
function reparationsSignal(war, warReparations, attackerGoldPrincipals, defenderGoldPrincipals) {
  if (!Array.isArray(warReparations) || !warReparations.length) return null;
  const startKey = dateKey(war.startDate);
  let best = null;
  let bestKey = null;
  for (const rep of warReparations) {
    if (typeof rep.payer !== "number" || typeof rep.receiver !== "number") continue;
    const repKey = dateKey(rep.startDate);
    if (repKey === null || (startKey !== null && repKey < startKey)) continue;
    let winnerSide = null;
    if (attackerGoldPrincipals.has(rep.payer) && defenderGoldPrincipals.has(rep.receiver)) winnerSide = "Defender";
    else if (defenderGoldPrincipals.has(rep.payer) && attackerGoldPrincipals.has(rep.receiver)) winnerSide = "Attacker";
    if (!winnerSide) continue;
    if (!best || repKey > bestKey) {
      best = winnerSide;
      bestKey = repKey;
    }
  }
  if (!best) return null;
  return {
    winnerSide: best,
    loserSide: best === "Attacker" ? "Defender" : "Attacker",
    reason: "post-war-reparations-enforced",
    // Deliberately larger than any land/gold strength value (land tops out
    // around locationCount*1000, gold around raw treasury deltas in the
    // thousands at most) so this always wins the sort below when present,
    // per the user's explicit call that enforced reparations are even more
    // reliable evidence than a land transfer.
    strength: Number.MAX_SAFE_INTEGER,
  };
}

// Reads a resolved-side-field's two values and reports a directional LEAN
// only when both sides show real, opposite-signed movement of a real (>=100)
// magnitude on whichever side is gaining - the exact same rigor the old
// treasury-swing DECISIVE check used, just repurposed for a non-decisive
// lean (see economicOutcomeSignal's big comment on why treasury/prestige no
// longer get to crown a winner at all).
function goldLikeLean(aValue, dValue) {
  if (typeof aValue !== "number" || typeof dValue !== "number") return null;
  if (aValue === 0 || dValue === 0 || Math.sign(aValue) === Math.sign(dValue)) return null;
  const gainerValue = aValue > 0 ? aValue : dValue;
  if (Math.abs(gainerValue) < 100) return null;
  return aValue > dValue ? "Attacker" : "Defender";
}

// A war whose own internal goal is literally "gain independence" - the game
// tags this directly (war.warName === "INDEPENDENCE_WAR_NAME", see
// js/clausewitz.js's extractWarFields and test/debug-war-name.js for the
// derivation), and by definition of this war type the ATTACKER is always
// the vassal fighting to break free, with the (former) overlord auto-joining
// the DEFENDER side. Land/gold rarely change hands in an independence peace
// (confirmed on real data: a real independence war showed 0/0 land and only
// a modest, non-decisive treasury swing, even though the outcome was
// completely unambiguous) - without this signal, that shape falls through to
// White Peace despite a real, decisive result.
//
// Deliberately does NOT need "before the war" snapshot data - EU5 already
// guarantees the pre-war relationship (that's what this war type means), so
// the only thing left to check is whether the vassal is STILL subject to one
// of the war's original defenders by the time the war disappears - if the
// AFTER snapshot's dependency data is gone (or points elsewhere), the vassal
// achieved independence; if it still points at one of the defenders, they
// lost and remain subjugated. (An earlier, more complex design compared
// dependency status before vs. after the war, using multi-snapshot history -
// abandoned once this simpler, more direct check was found: the vassal's own
// `overlord` field reads null almost immediately upon DECLARING an
// independence war, not just upon winning it, which would have made a
// before/after comparison unreliable for exactly the case this exists to
// catch.)
// `war.revolt` covers BOTH INDEPENDENCE_WAR_NAME (a vassal fighting to break
// free) and CIVIL_WAR_NAME (a pretender contesting the throne) - the
// rebel/pretender is always the ATTACKER (confirmed on real data: 7/7 revolt
// wars in a real campaign had `revolter: true` on the Attacker side, never
// the Defender).
//
// Real bug found on real data: the old version of this signal (named
// independenceSignal, INDEPENDENCE_WAR_NAME-only) returned null the moment
// the attacker's country was missing from `afterCountries` (`if (!info)
// return null`) - exactly what happens when the player FULLY ANNEXES the
// rebel back (same "vanished" pattern documented in sideEconomyDeltas'
// comment), so a clean, decisive crush fell through to weaker signals
// instead of being recognized as a Defender win. Worse: if the rebel's tag
// survived a snapshot or two as an empty `locationCount: 0` stub (rather
// than vanishing outright - also documented as real in sideEconomyDeltas'
// comment) with `overlord` already cleared, the OLD `stillSubjugated` check
// read that as "independence achieved" and credited the ATTACKER with a win
// - the exact inverted-outcome bug the user reported (full annexation of a
// rebel scored as a loss). Fixed: a rebel with no land left (vanished OR
// `locationCount === 0`) is checked FIRST and is always a Defender win
// (crushed), regardless of what its `overlord` field says - only a rebel
// that's still a going concern with real land afterward falls through to
// the subjugation check below.
function revoltOutcomeSignal(war, afterCountries) {
  if (!war.revolt) return null;
  const attacker = war.originalAttacker;
  const defenders = war.originalDefenders || [];
  if (typeof attacker !== "number" || !afterCountries) return null;
  const info = afterCountries[attacker];
  const crushed = !info || (typeof info.locationCount === "number" && info.locationCount === 0);
  if (crushed) {
    return { winnerSide: "Defender", loserSide: "Attacker", reason: "post-war-revolt-crushed", strength: Number.MAX_SAFE_INTEGER };
  }
  // The "still subjugated to a defender = they lost, independence not
  // granted" check only makes sense for an actual INDEPENDENCE_WAR_NAME (a
  // real vassal/overlord relationship to test) - a CIVIL_WAR_NAME pretender
  // that's still around with land afterward has no equivalent relationship
  // to check, so it falls through to land-transfer/reparations instead of
  // guessing here.
  if (war.warName !== "INDEPENDENCE_WAR_NAME") return null;
  const stillSubjugated = typeof info.overlord === "number" && defenders.includes(info.overlord);
  return {
    winnerSide: stillSubjugated ? "Defender" : "Attacker",
    loserSide: stillSubjugated ? "Attacker" : "Defender",
    reason: "post-war-independence-granted",
    // Same tier as reparations - a direct state check, not an inferred delta.
    strength: Number.MAX_SAFE_INTEGER,
  };
}

// Returns { decisive, contributing, breakdown }: `decisive` is the single
// strongest qualifying DECISIVE signal (or null - only reparations, land
// transfer, and independence are eligible, see below), `contributing` is
// every OTHER DECISIVE-eligible signal that also qualified but lost out, and
// `breakdown` is a full numeric account of every factor this function looked
// at (decisive or not) for the UI's expandable "how was this decided" detail
// view.
//
// Per the user's explicit call: treasury swing, like prestige before it, is
// being DEMOTED from decisive to informational-only. Real data this session
// found repeated false positives from it even after two rounds of
// tightening the threshold (a big campaigning army outspending a defender
// regardless of outcome; one side hemorrhaging money on unrelated war costs
// while the other only incidentally gained a little) - the user's read is
// that gold, like prestige, has too many reasons to swing that have nothing
// to do with who actually won THIS war. Only land transfer (a real
// before/after territory comparison), enforced war reparations, and granted
// independence (both literal, non-inferred peace-treaty facts) are trusted
// to crown a winner now. Treasury and prestige are still computed and
// surfaced - as contributingFactors/breakdown entries, same tier as
// war-score/battle-losses/occupation - just never decisive.
function economicOutcomeSignal(war, economy, warReparations, afterCountries) {
  const breakdown = [];
  const signals = [];
  const revoltOutcome = revoltOutcomeSignal(war, afterCountries);
  if (revoltOutcome) signals.push(revoltOutcome);
  breakdown.push({
    key: "independence",
    label: "Independence granted",
    decisive: true,
    applies: !!revoltOutcome,
    winnerSide: revoltOutcome ? revoltOutcome.winnerSide : null,
    attackerValue: null,
    defenderValue: null,
  });
  if (!economy || !economy.Attacker || !economy.Defender) {
    if (!signals.length) return { decisive: null, contributing: [], breakdown };
    signals.sort((a, b) => b.strength - a.strength);
    return { decisive: signals[0], contributing: signals.slice(1), breakdown };
  }
  const attackerPrincipalsBase = principalCountrySet(war.originalAttacker, war);
  const defenderPrincipalsBase = principalCountrySet(war.originalDefenders, war);
  const attackerPrincipals = principalsWithOverlords(attackerPrincipalsBase, war);
  const defenderPrincipals = principalsWithOverlords(defenderPrincipalsBase, war);
  const attackerGoldPrincipals = principalsForGold(attackerPrincipalsBase, war);
  const defenderGoldPrincipals = principalsForGold(defenderPrincipalsBase, war);

  const aLoc = resolveSideField(economy.Attacker, attackerPrincipals, "locationDelta");
  const dLoc = resolveSideField(economy.Defender, defenderPrincipals, "locationDelta");
  const aGoldR = resolveSideField(economy.Attacker, attackerGoldPrincipals, "goldDelta");
  const dGoldR = resolveSideField(economy.Defender, defenderGoldPrincipals, "goldDelta");
  // Prestige reuses the gold-principal substitution (an overlord replaces a
  // vassal, per the same "a vassal has no standing of its own in a peace"
  // reasoning) - it's informational only, so this is a judgment call, not a
  // load-bearing one.
  const aPrestigeR = resolveSideField(economy.Attacker, attackerGoldPrincipals, "prestigeDelta");
  const dPrestigeR = resolveSideField(economy.Defender, defenderGoldPrincipals, "prestigeDelta");

  const aGold = aGoldR.value;
  const dGold = dGoldR.value;
  const aLocations = aLoc.value;
  const dLocations = dLoc.value;
  const aPrestige = aPrestigeR.value;
  const dPrestige = dPrestigeR.value;

  const reparations = reparationsSignal(war, warReparations, attackerGoldPrincipals, defenderGoldPrincipals);
  if (reparations) signals.push(reparations);
  breakdown.push({
    key: "reparations",
    label: "War reparations",
    decisive: true,
    applies: !!reparations,
    winnerSide: reparations ? reparations.winnerSide : null,
    attackerValue: null,
    defenderValue: null,
  });

  let landApplies = false;
  let landWinner = null;
  if (typeof aLocations === "number" && typeof dLocations === "number") {
    const spread = aLocations - dLocations;
    // Both principal sides must show a REAL (nonzero) location change for
    // this to be evidence of land actually exchanged between THEM
    // specifically. Confirmed on real data (pure-reparations wars where the
    // loser paid gold only): the loser's own location delta was exactly 0
    // while the winner's showed an unrelated nonzero swing (some other war/
    // colonization concluding in the same snapshot window, not land taken
    // from this opponent) - the old check treated 0 as "opposite sign" from
    // any nonzero value and wrongly called that a clean two-sided transfer.
    // A genuine bilateral transfer moves both sides' counts in real,
    // opposite directions (e.g. -24 / +24, an exact mirror); one side
    // sitting at exactly 0 proves nothing came from/went to this opponent,
    // whatever the other side's unrelated change was.
    const winnerSide = spread > 0 ? "Attacker" : "Defender";
    if (
      aLocations !== 0 &&
      dLocations !== 0 &&
      Math.abs(spread) >= 2 &&
      Math.sign(aLocations) !== Math.sign(dLocations)
    ) {
      const clean = aLoc.usedPrincipal && dLoc.usedPrincipal;
      landApplies = true;
      landWinner = winnerSide;
      signals.push({
        winnerSide,
        loserSide: winnerSide === "Attacker" ? "Defender" : "Attacker",
        reason: clean ? "post-war-land-transfer" : "post-war-land-transfer-coalition",
        strength: Math.abs(spread) * 1000,
      });
    }
  } else if (typeof aLocations === "number" || typeof dLocations === "number") {
    const side = typeof aLocations === "number" ? "Attacker" : "Defender";
    const value = typeof aLocations === "number" ? aLocations : dLocations;
    const clean = side === "Attacker" ? aLoc.usedPrincipal : dLoc.usedPrincipal;
    const winnerSide = value > 0 ? side : side === "Attacker" ? "Defender" : "Attacker";
    if (Math.abs(value) >= 1) {
      landApplies = true;
      landWinner = winnerSide;
      signals.push({
        winnerSide,
        loserSide: winnerSide === "Attacker" ? "Defender" : "Attacker",
        reason: clean ? "post-war-land-transfer" : "post-war-land-transfer-coalition",
        strength: Math.abs(value) * 1000,
      });
    }
  }
  breakdown.push({
    key: "land-transfer",
    label: "Land transfer",
    decisive: true,
    applies: landApplies,
    winnerSide: landWinner,
    attackerValue: aLocations,
    defenderValue: dLocations,
    attackerLocationsGained: principalFieldUnion(economy.Attacker, attackerPrincipals, "locationsGained"),
    attackerLocationsLost: principalFieldUnion(economy.Attacker, attackerPrincipals, "locationsLost"),
    defenderLocationsGained: principalFieldUnion(economy.Defender, defenderPrincipals, "locationsGained"),
    defenderLocationsLost: principalFieldUnion(economy.Defender, defenderPrincipals, "locationsLost"),
  });

  const treasuryLean = goldLikeLean(aGold, dGold);
  breakdown.push({
    key: "treasury",
    label: "Treasury swing",
    decisive: false,
    applies: typeof aGold === "number" && typeof dGold === "number",
    winnerSide: treasuryLean,
    attackerValue: aGold,
    defenderValue: dGold,
  });

  const prestigeLean = goldLikeLean(aPrestige, dPrestige);
  breakdown.push({
    key: "prestige",
    label: "Prestige swing",
    decisive: false,
    applies: typeof aPrestige === "number" && typeof dPrestige === "number",
    winnerSide: prestigeLean,
    attackerValue: aPrestige,
    defenderValue: dPrestige,
  });

  if (!signals.length) return { decisive: null, contributing: [], breakdown };
  signals.sort((a, b) => b.strength - a.strength);
  return { decisive: signals[0], contributing: signals.slice(1), breakdown };
}

// Battle-inflicted casualties (Battle+Capture, NOT Attrition) compared
// between sides - unlike Attrition, which a large/far-from-home invading
// army racks up regardless of whether it's winning (confirmed on a real
// concluded war: the attacker held 92% of contested territory yet had the
// only recorded losses, all Attrition, none Battle - a clean Attacker win
// with a heavily attrited army, not a contradiction), Battle/Capture losses
// are actually inflicted by the other side, so a lopsided split there is a
// real (if indirect) signal of who's losing the fight. Needs a minimum
// sample and a decisive-enough margin to matter - see thresholds below.
function battleLossSignal(war) {
  const a = war.attackerLosses;
  const d = war.defenderLosses;
  if (!a || !d) return null;
  const aCombat = (a.battle || 0) + (a.capture || 0);
  const dCombat = (d.battle || 0) + (d.capture || 0);
  const total = aCombat + dCombat;
  if (total < 50) return null; // too small a sample to read anything into
  const spread = dCombat - aCombat; // positive -> attacker inflicted more -> attacker likely winning
  if (Math.abs(spread) / total < 0.2) return null; // not a decisive enough margin
  return { winnerSide: spread > 0 ? "Attacker" : "Defender", reason: "battle-losses-inflicted" };
}

const CONFIDENCE_ORDER = ["unknown", "low", "medium", "high"];
function shiftConfidence(level, delta) {
  const idx = CONFIDENCE_ORDER.indexOf(level);
  if (idx < 0) return level;
  return CONFIDENCE_ORDER[Math.max(0, Math.min(CONFIDENCE_ORDER.length - 1, idx + delta))];
}

// Maps an economicOutcomeSignal reason code to the short label used in
// contributingFactors, so a land signal that LOST out to reparations (see
// economicOutcomeSignal's `contributing`) still shows up as "considered but
// not decisive" the same way war-score/battle-losses do.
const CONTRIBUTING_SIGNAL_FROM_REASON = {
  "post-war-reparations-enforced": "reparations",
  "post-war-independence-granted": "independence",
  "post-war-revolt-crushed": "independence",
  "post-war-land-transfer": "land-transfer",
  "post-war-land-transfer-coalition": "land-transfer",
};

function inferOutcome(war, disappeared, economy, warReparations, afterCountries) {
  const aScore = war.attackerScore;
  const dScore = war.defenderScore;
  const lossSignal = battleLossSignal(war);
  const scoreSignal =
    typeof aScore === "number" && typeof dScore === "number" && aScore !== dScore
      ? { winnerSide: aScore > dScore ? "Attacker" : "Defender" }
      : null;
  const aCombat = war.attackerLosses ? (war.attackerLosses.battle || 0) + (war.attackerLosses.capture || 0) : null;
  const dCombat = war.defenderLosses ? (war.defenderLosses.battle || 0) + (war.defenderLosses.capture || 0) : null;
  const occ = war.occupation;
  const occupationLean =
    occ && typeof occ.attackerLocations === "number" && typeof occ.defenderLocations === "number" && occ.attackerLocations !== occ.defenderLocations
      ? occ.attackerLocations > occ.defenderLocations
        ? "Attacker"
        : "Defender"
      : null;

  // Per the user's explicit call (js/llama-score.js's copy of this function
  // has the full writeup, kept in sync deliberately): war score, battle
  // losses, occupation, treasury, and prestige never decide a winner on
  // their own - each one moves for reasons that don't reliably track who
  // actually won THIS specific war (a two-sided war score is frequently a
  // partial-clear artifact from EU5's own end-of-war cleanup; a winning
  // invader can still rack up heavy battle losses; occupying land mid-war
  // isn't the same as keeping it; treasury and prestige both swing from
  // battles/events/unrelated spending as often as from the war's actual
  // outcome). Only land transfer (a real before/after territory comparison)
  // and enforced war reparations (economicOutcomeSignal, a literal peace-
  // treaty term) decide who won; everything else is attached below as
  // contributingFactors/breakdown so the reasoning stays visible/auditable
  // without ever being trusted to pick a side by itself - not even when
  // several of them happen to agree.
  const economicSignal = economicOutcomeSignal(war, economy, warReparations, afterCountries);
  const treasuryFactor = economicSignal.breakdown.find((f) => f.key === "treasury");
  const prestigeFactor = economicSignal.breakdown.find((f) => f.key === "prestige");
  const fullBreakdown = economicSignal.breakdown.concat([
    { key: "war-score", label: "War score", decisive: false, applies: !!scoreSignal, winnerSide: scoreSignal ? scoreSignal.winnerSide : null, attackerValue: aScore, defenderValue: dScore },
    { key: "battle-losses", label: "Casualties inflicted", decisive: false, applies: !!lossSignal, winnerSide: lossSignal ? lossSignal.winnerSide : null, attackerValue: dCombat, defenderValue: aCombat },
    { key: "occupation", label: "Occupied enemy territory", decisive: false, applies: occupationLean != null, winnerSide: occupationLean, attackerValue: occ ? occ.attackerLocations : null, defenderValue: occ ? occ.defenderLocations : null },
  ]);

  function finalize(result, extraContributing) {
    let confidence = result.confidence;
    let lossSignalAgrees = null;
    if (lossSignal && result.winnerSide != null) {
      lossSignalAgrees = lossSignal.winnerSide === result.winnerSide;
      confidence = shiftConfidence(confidence, lossSignalAgrees ? 1 : 0);
    }
    if (typeof war.stalledYears === "number" && war.stalledYears >= 2) {
      confidence = shiftConfidence(confidence, -1);
    }
    const contributingFactors = [];
    if (scoreSignal) contributingFactors.push({ signal: "war-score", winnerSide: scoreSignal.winnerSide });
    if (lossSignal) contributingFactors.push({ signal: "battle-losses", winnerSide: lossSignal.winnerSide });
    if (treasuryFactor && treasuryFactor.winnerSide) contributingFactors.push({ signal: "treasury", winnerSide: treasuryFactor.winnerSide });
    if (prestigeFactor && prestigeFactor.winnerSide) contributingFactors.push({ signal: "prestige", winnerSide: prestigeFactor.winnerSide });
    for (const s of extraContributing || []) {
      contributingFactors.push({ signal: CONTRIBUTING_SIGNAL_FROM_REASON[s.reason] || s.reason, winnerSide: s.winnerSide });
    }
    return { ...result, confidence, lossSignalAgrees, contributingFactors, attackerScore: aScore, defenderScore: dScore, breakdown: fullBreakdown };
  }

  // The only decisive checks in this function: an enforced reparations
  // obligation (strongest - see reparationsSignal) and before/after
  // territory change, restricted to the war's two original principals (see
  // economicOutcomeSignal's own comments for the nonzero-both-sides fix and
  // the principal/coalition split). Both get "high" confidence (about as
  // unambiguous as this game's data gets).
  if (economicSignal.decisive) {
    return finalize(
      {
        winnerSide: economicSignal.decisive.winnerSide,
        loserSide: economicSignal.decisive.loserSide,
        confidence: "high",
        reason: economicSignal.decisive.reason,
      },
      economicSignal.contributing
    );
  }

  // Deliberately NOT falling back to war.occupation (who's occupying more
  // contested territory at the moment the war disappears) to DECIDE anything
  // here - confirmed wrong on real data twice now (see js/llama-score.js's
  // copy of this function): occupation called 4 of 5 real wars for the wrong
  // side even as the PRIMARY signal. Occupying land mid-war is not the same
  // as keeping it - only land TRANSFER (a real before/after comparison) and
  // enforced reparations can tell those apart. Occupation is still surfaced
  // above as a breakdown/contributingFactors entry (informational only, same
  // tier as war-score/battle-losses/treasury/prestige), just never used to
  // pick a winner.

  // No reparations were enforced and no land actually changed hands between
  // the two principals - default to White Peace. War score/battle-losses/
  // occupation/treasury/prestige are still attached above as
  // contributingFactors/breakdown for anyone auditing the call, but per the
  // user's call none of them gets to crown a winner on its own - a white
  // peace costs nothing to get right, and the per-row manual override still
  // corrects it if this genuinely was decisive.
  return finalize(
    {
      winnerSide: null,
      loserSide: null,
      confidence: "unknown",
      reason: disappeared ? "war-disappeared-without-decisive-signal" : "active-or-tied",
    },
    economicSignal.contributing
  );
}

function warSummary(war) {
  const participants = participantSummariesWithSides(war);
  const summary = {
    number: war.number,
    startDate: war.startDate,
    endDate: war.endDate,
    concluded: !!war.concluded,
    revolt: !!war.revolt,
    originalAttacker: war.originalAttacker,
    originalDefenders: war.originalDefenders || [],
    // The game's own internal war-goal label (see js/clausewitz.js's
    // extractWarFields) - "INDEPENDENCE_WAR_NAME", "CIVIL_WAR_NAME",
    // "NORMAL_WAR_NAME", etc. Used directly by independenceSignal below, and
    // surfaced to the UI as a "Type" column so a war's own real goal is
    // visible, not just guessed at.
    warName: war.warName || null,
    attackerScore: war.attackerScore,
    defenderScore: war.defenderScore,
    warGoalHeld: war.warGoalHeld,
    occupation: war.occupation,
    // Unlike attacker_score/defender_score above, these war-wide casualty
    // totals survive war conclusion (confirmed on a real concluded war) -
    // see js/clausewitz.js's extractWarFields and inferOutcome() below.
    attackerLosses: war.attackerLosses,
    defenderLosses: war.defenderLosses,
    stalledYears: war.stalledYears,
    sides: countriesBySide(participants),
    participants,
  };
  summary.outcome = inferOutcome(summary, false, null);
  return summary;
}

function warFingerprint(war) {
  const compact = {
    concluded: war.concluded,
    endDate: war.endDate,
    attackerScore: war.attackerScore,
    defenderScore: war.defenderScore,
    warGoalHeld: war.warGoalHeld,
    occupation: war.occupation,
    attackerLosses: war.attackerLosses,
    defenderLosses: war.defenderLosses,
    stalledYears: war.stalledYears,
    participants: (war.participants || []).map((p) => [p.country, p.side, p.status, p.leaveDate, p.combat, p.siege]),
  };
  return crypto.createHash("sha1").update(JSON.stringify(compact)).digest("hex");
}

function playerCountryNumbers(result) {
  const nums = new Set();
  for (const p of result.players || []) if (typeof p.countryNumber === "number") nums.add(p.countryNumber);
  for (const p of result.playerSessions || []) if (typeof p.countryNumber === "number") nums.add(p.countryNumber);
  for (const c of result.countries || []) if (c.players && c.players.length) nums.add(c.number);
  return nums;
}

function warTouchesCountries(war, countryNumbers) {
  if (!countryNumbers || !countryNumbers.size || !war) return false;
  if (countryNumbers.has(war.originalAttacker)) return true;
  for (const c of war.originalDefenders || []) if (countryNumbers.has(c)) return true;
  for (const p of war.participants || []) if (countryNumbers.has(p.country)) return true;
  return false;
}

function buildSnapshot(file, hash, result, config, previousWars) {
  const countries = result.countries || [];
  const countryByNumber = result.countriesByNumber || new Map(countries.map((c) => [c.number, c]));
  const date = result.metadata && result.metadata.date;
  const playerCountriesSet = playerCountryNumbers(result);
  const rawWars = config.playerWarsOnly && playerCountriesSet.size ? (result.wars || []).filter((war) => warTouchesCountries(war, playerCountriesSet)) : result.wars || [];
  const wars = rawWars.map(warSummary);
  const interestingCountries = new Set();
  for (const c of countries) {
    if (c.players && c.players.length) interestingCountries.add(c.number);
  }
  for (const war of wars) {
    if (typeof war.originalAttacker === "number") interestingCountries.add(war.originalAttacker);
    for (const c of war.originalDefenders || []) interestingCountries.add(c);
    for (const p of war.participants || []) if (typeof p.country === "number") interestingCountries.add(p.country);
  }
  for (const previous of Object.values(previousWars || {})) {
    const war = previous && previous.lastWar;
    if (!war) continue;
    if (typeof war.originalAttacker === "number") interestingCountries.add(war.originalAttacker);
    for (const c of war.originalDefenders || []) interestingCountries.add(c);
    for (const p of war.participants || []) if (typeof p.country === "number") interestingCountries.add(p.country);
  }
  const overlordOf = buildOverlordLookup(result);
  // A brand-new subject of an already-interesting country (e.g. a player
  // fully conquers an opponent's provinces and releases them straight into
  // a new vassal instead of keeping them, a real EU5 peace-deal option) is
  // otherwise invisible forever - it's not a player, and it was never a war
  // participant since it didn't exist until the peace treaty created it, so
  // it would never enter interestingCountries any other way. Tracking it
  // from here on lets sideEconomyDeltas (below) attribute its land back to
  // whichever principal formed it, instead of the conquest silently
  // vanishing because the principal's OWN locationCount never moves.
  for (const c of countries) {
    const overlord = overlordOf.get(c.number);
    if (typeof overlord === "number" && interestingCountries.has(overlord)) interestingCountries.add(c.number);
  }
  const countryLookup = {};
  for (const n of interestingCountries) {
    const c = countryByNumber.get(n);
    if (c) countryLookup[n] = countrySummary(c, overlordOf, true);
  }
  const culturesByNumber = new Map((result.cultures || []).map((entry) => [entry.number, entry]));
  const religionsByNumber = new Map((result.religions || []).map((entry) => [entry.number, entry]));
  const playerCountries = countries
    .filter((c) => c.players && c.players.length)
    .map((c) => {
      const summary = countrySummary(c, overlordOf, true, true);
      if (summary.modifierState) {
        const culture = culturesByNumber.get(c.primaryCulture);
        const religion = religionsByNumber.get(c.primaryReligion);
        summary.modifierState = Object.assign({}, summary.modifierState, {
          currentTag: c.tag,
          originalTag: c.originalTag,
          governmentType: c.governmentType,
          primaryCulture: culture && (culture.definition || culture.name),
          primaryReligion: religion && (religion.definition || religion.key || religion.name),
          religionGroup: religion && religion.group,
          societalDynamics: societalDynamicFacts(c, result),
          internationalOrganizations: (result.internationalOrganizations || [])
            .filter((organization) => organization.members.includes(c.number))
            .map((organization) => ({
              type: organization.type,
              leader: organization.leader === c.number,
              laws: organization.laws,
              lawHistory: organization.lawHistory,
            })),
        });
      }
      return summary;
    });
  const economyCountries = config.storeAllEconomyCountries ? allCountryLookup(countries, overlordOf) : countryLookup;
  return {
    modifierStateSchemaVersion: MODIFIER_STATE_SCHEMA_VERSION,
    capturedAt: new Date().toISOString(),
    sourceFile: path.basename(file),
    campaignKey: campaignKeyFromFile(file),
    sourceHash: hash,
    date,
    year: dateParts(date).year,
    playthroughName: result.metadata && result.metadata.playthrough_name,
    gameVersion: result.metadata && result.metadata.version,
    playerCountries,
    countries: countryLookup,
    economyCountries,
    wars,
    warFilter: config.playerWarsOnly ? "player" : "all",
    // Enforced war-reparations obligations (see js/clausewitz.js's
    // extractWarReparationsFields) - small (hundreds of entries even
    // late-game, ~50 bytes each), always kept, no includeXxx gate needed,
    // same as dependencies above. Lasts ~10 in-game years per obligation, far
    // longer than war_manager keeps a concluded war's own record around, so
    // this is the most durable win/loss signal available (see
    // economicOutcomeSignal's reparationsSignal, which reads this directly).
    warReparations: result.warReparations || [],
    // Set by the parser when it had to bail out of the gamestate scan early
    // (see js/clausewitz-binary.js's parseCompressedSave) - null on a clean
    // parse. A non-null value means this snapshot's playerCountries/
    // countries/wars may be silently incomplete (possibly all empty)
    // despite looking like a normal recording - exactly what happened for
    // real across 25 straight autosaves in one campaign before this field
    // existed (see CHANGELOG). Kept on the snapshot itself, not just
    // console-logged, so a suspect snapshot can be found/filtered later
    // instead of only being visible in a terminal no one was watching at
    // 1am.
    parseWarning: result.parseWarning || null,
  };
}

function classifyEvents(previousWars, snapshot) {
  const events = [];
  const current = {};
  const economyCountries = snapshot.economyCountries || snapshot.countries || {};
  for (const war of snapshot.wars) {
    const fp = warFingerprint(war);
    const previous = previousWars[String(war.number)];
    // EU5 clears attacker_score/defender_score partway through a war's life
    // (sometimes one side, sometimes both) well before the war actually
    // disappears - confirmed on real data: a war with real land/reparations
    // evidence still had BOTH scores null by the time it disappeared, even
    // though an earlier still-active snapshot had seen a real value for at
    // least one side. Carry the LAST KNOWN non-null score forward across
    // snapshots (per side, independently) instead of losing it the moment
    // the live field goes blank, so a war-disappeared event's own lastWar
    // (and the war-score breakdown/contributingFactor built from it) still
    // has real evidence when the game itself once showed some.
    const lastKnownAttackerScore = typeof war.attackerScore === "number" ? war.attackerScore : previous && typeof previous.lastKnownAttackerScore === "number" ? previous.lastKnownAttackerScore : null;
    const lastKnownDefenderScore = typeof war.defenderScore === "number" ? war.defenderScore : previous && typeof previous.lastKnownDefenderScore === "number" ? previous.lastKnownDefenderScore : null;
    current[war.number] = {
      fingerprint: fp,
      startDate: war.startDate,
      lastSeenDate: snapshot.date,
      lastSnapshotHash: snapshot.sourceHash,
      lastWar: war,
      lastCountries: economyCountries,
      lastKnownAttackerScore,
      lastKnownDefenderScore,
    };
    if (!previous) {
      events.push({ type: "war-start", warNumber: war.number, date: snapshot.date, sourceHash: snapshot.sourceHash, war });
    } else if (previous.fingerprint !== fp) {
      events.push({ type: "war-update", warNumber: war.number, date: snapshot.date, sourceHash: snapshot.sourceHash, war });
    }
  }
  for (const [warNumber, previous] of Object.entries(previousWars)) {
    if (!current[warNumber]) {
      // Apply the same carried-forward score to the FINAL lastWar snapshot
      // handed to inferOutcome/stored in the event - a shallow clone so the
      // mutation can't leak back into `previous.lastWar` (not referenced
      // anywhere else once this war has left `current`, but cloning keeps
      // that true even if that ever changes).
      const lastWar = previous.lastWar ? { ...previous.lastWar } : null;
      if (lastWar) {
        if (lastWar.attackerScore == null && typeof previous.lastKnownAttackerScore === "number") lastWar.attackerScore = previous.lastKnownAttackerScore;
        if (lastWar.defenderScore == null && typeof previous.lastKnownDefenderScore === "number") lastWar.defenderScore = previous.lastKnownDefenderScore;
      }
      const economy = lastWar ? sideEconomyDeltas(lastWar, previous.lastCountries, economyCountries) : null;
      const previousMeta = {
        fingerprint: previous.fingerprint,
        startDate: previous.startDate,
        lastSeenDate: previous.lastSeenDate,
        lastSnapshotHash: previous.lastSnapshotHash,
      };
      events.push({
        type: "war-disappeared",
        warNumber: Number(warNumber),
        date: snapshot.date,
        sourceHash: snapshot.sourceHash,
        lastWar,
        inferredOutcome: lastWar ? inferOutcome(lastWar, true, economy, snapshot.warReparations, economyCountries) : null,
        economyDelta: economy,
        previous: previousMeta,
      });
    }
  }
  return { events, currentWars: current };
}

function shouldArchive(events, snapshot, state, config) {
  if (!config.archiveFullSaves) return false;
  if (events.length) return true;
  if (!snapshot.year || !config.checkpointYears) return false;
  const key = `${snapshot.campaignKey || snapshot.playthroughName || "campaign"}:${Math.floor(snapshot.year / config.checkpointYears)}`;
  if (state.checkpoints[key]) return false;
  state.checkpoints[key] = snapshot.sourceHash;
  return true;
}

function archiveSave(file, snapshot, config) {
  const archiveDir = campaignArchiveDir(config, snapshot.campaignKey);
  ensureDir(archiveDir);
  const safeDate = String(snapshot.date || "unknown").replace(/[^\w.-]+/g, "_");
  const out = path.join(archiveDir, `${safeDate}_${snapshot.sourceHash.slice(0, 12)}_${path.basename(file)}`);
  if (!fs.existsSync(out)) fs.copyFileSync(file, out);
  return out;
}

// Returns each campaign's LOGICAL snapshots.jsonl path (whether the plain
// file or its .gz compaction is what's actually on disk right now) -
// callers read the content via readLedgerText(), which resolves either form
// transparently.
function listCampaignSnapshotFiles(config) {
  if (!fs.existsSync(config.campaignsDir)) return [];
  const files = [];
  for (const d of fs.readdirSync(config.campaignsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const file = path.join(config.campaignsDir, d.name, "snapshots.jsonl");
    if (fs.existsSync(file) || fs.existsSync(ledgerGzFile(file))) files.push(file);
  }
  return files;
}

function hydrateStateFromSnapshots(config, state) {
  const files = listCampaignSnapshotFiles(config);
  if (!files.length) return;
  const latestByCampaign = new Map();
  for (const file of files) {
    const lines = readLedgerText(file).split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const snapshot = JSON.parse(line);
        if (!snapshot || !snapshot.campaignKey) continue;
        const prev = latestByCampaign.get(snapshot.campaignKey);
        if (!prev || compareDates(snapshot.date, prev.date) > 0) latestByCampaign.set(snapshot.campaignKey, snapshot);
      } catch {
        // Keep the recorder resilient if a JSONL line was interrupted.
      }
    }
  }
  if (!latestByCampaign.size) return;
  state.activeWarsByCampaign = state.activeWarsByCampaign || {};
  state.lastDateByCampaign = state.lastDateByCampaign || {};
  for (const [campaignKey, snapshot] of latestByCampaign.entries()) {
    // snapshots.jsonl is the durable source of truth. This assignment must
    // also be allowed to move BACKWARD after an intentional ledger rollback;
    // keeping a newer cache date would make every genuine resumed save look
    // out of order and suppress war-event tracking until that stale date.
    state.lastDateByCampaign[campaignKey] = snapshot.date;
    const countries = snapshot.economyCountries || snapshot.countries || {};
    const wars = {};
    for (const war of snapshot.wars || []) {
      wars[war.number] = {
        fingerprint: warFingerprint(war),
        startDate: war.startDate,
        lastSeenDate: snapshot.date,
        lastSnapshotHash: snapshot.sourceHash,
        lastWar: war,
        lastCountries: countries,
        // Only the LATEST snapshot per campaign is read here (see the loop
        // above), so there's no deeper history to recover a score from if
        // this one snapshot already shows null - same shape as
        // classifyEvents' carry-forward fields (see its comment) so a
        // restart mid-war doesn't lose the carrying mechanism itself, just
        // whatever history predates this specific snapshot.
        lastKnownAttackerScore: typeof war.attackerScore === "number" ? war.attackerScore : null,
        lastKnownDefenderScore: typeof war.defenderScore === "number" ? war.defenderScore : null,
      };
    }
    state.activeWarsByCampaign[campaignKey] = wars;
  }
}

async function processFile(file, config, state) {
  if (!isStable(file, config.stableMs)) return false;
  const stat = tryStat(file);
  if (!stat) return false;
  const known = state.files[file];
  if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) return false;

  const { hash, result } = await readAndParseSave(file, config);
  return processParsedFile(file, stat, hash, result, config, state);
}

// state.activeWarsByCampaign accumulates one entry per campaign EVER
// recorded, forever - confirmed on the user's real, months-old data dir:
// 22 campaigns' worth (305KB of a 750KB state.json) even though
// campaignMode "latest" (the default) only ever tracks ONE campaign going
// forward. The other 21 entries are pure dead weight: nothing will update
// them again (hydrateStateFromSnapshots() at startup can always rebuild any
// campaign's war-state fresh from its own snapshots.jsonl if it's ever
// tracked again), yet they got re-serialized and rewritten to disk on every
// single autosave processed regardless of which campaign it belonged to.
// Only safe to prune in "latest" mode specifically - "all"/"specific" modes
// can legitimately be tracking more than one campaign at once.
//
// Bounded tradeoff, accepted deliberately: if "latest" ever flips BACK to a
// campaign that was pruned away in the meantime (e.g. the user alternates
// saves between two actively-played campaigns across sessions), that
// campaign's already-known wars will each log one spurious extra
// "war-start" event on its next snapshot (classifyEvents sees an empty
// previousWars and treats every currently-active war as brand new). This is
// harmless noise, not a scoring bug: outcomes/scoring only ever come from
// "war-disappeared" events, which classifyEvents derives independently by
// comparing the war-events history, not from war-start events. Worth
// revisiting only if the user's real workflow turns out to toggle between
// multiple live campaigns like this regularly.
function pruneStaleCampaignState(state, config, keepCampaignKey) {
  if (config.campaignMode !== "latest") return;
  for (const key of Object.keys(state.activeWarsByCampaign)) {
    if (key !== keepCampaignKey) delete state.activeWarsByCampaign[key];
  }
}

async function processParsedFile(file, stat, hash, result, config, state, forceModifierStateRefresh) {
  const known = state.files[file];
  if (!forceModifierStateRefresh && known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) return false;
  if (!forceModifierStateRefresh && state.hashes[hash]) {
    state.files[file] = { mtimeMs: stat.mtimeMs, size: stat.size, hash };
    return false;
  }
  state.activeWarsByCampaign = state.activeWarsByCampaign || {};
  const campaignKey = campaignKeyFromFile(file);
  const previousWars = state.activeWarsByCampaign[campaignKey] || {};
  const snapshot = buildSnapshot(file, hash, result, config, previousWars);
  state.lastDateByCampaign = state.lastDateByCampaign || {};
  const lastDate = state.lastDateByCampaign[snapshot.campaignKey];
  ensureDir(campaignDir(config, snapshot.campaignKey));
  // Undo any earlier compaction before the appendJsonl() calls below - gzip
  // can't be appended to in place, and a campaign that's about to receive a
  // new autosave is by definition active again (see scan()'s compaction
  // call site, which only ever compacts campaigns NOT being processed this
  // tick).
  decompactCampaignLedger(config, snapshot.campaignKey);

  // A snapshot arriving many YEARS ahead of the last one this campaign
  // tracked is far more likely to be an exploratory/test continuation
  // (reloading an old singleplayer save to try something, which autosaves
  // under the exact same filename/campaign key - campaignKeyFromFile has no
  // way to tell that apart from genuine uninterrupted play) than a real
  // multi-decade time skip. Diffing classifyEvents() against a previousWars
  // baseline this stale produces nonsense events - wars that "start" but
  // actually started AND ended somewhere in the unobserved gap, wars that
  // "disappear" but are still genuinely ongoing. Confirmed on real data: a
  // 48-year jump (1455->1503) produced 3 bogus war-start events and 1 false
  // war-disappeared event, only caught and hand-fixed after the fact.
  //
  // Same philosophy as the out-of-order branch below - never silently drop
  // real data. The snapshot is preserved in a sibling anomalies.jsonl
  // instead of snapshots.jsonl, and lastDateByCampaign/activeWarsByCampaign
  // are left untouched, so a LATER snapshot that actually resumes the real
  // campaign near where it left off keeps diffing against genuine history
  // instead of this gap. See tools/campaign-ledger-doctor.js to inspect or
  // "promote" a quarantined entry if a jump like this turns out to have
  // been intentional after all.
  const yearGap = lastDate ? dateParts(snapshot.date).year - dateParts(lastDate).year : null;
  if (lastDate && Number.isFinite(yearGap) && yearGap > config.maxForwardYearGap && compareDates(snapshot.date, lastDate) > 0) {
    appendJsonl(
      campaignAnomaliesFile(config, snapshot.campaignKey),
      Object.assign({}, snapshot, { anomalyReason: `${yearGap} year jump ahead of the last tracked date (${lastDate})` })
    );
    state.files[file] = { mtimeMs: stat.mtimeMs, size: stat.size, hash };
    state.hashes[hash] = { file: path.basename(file), date: snapshot.date, capturedAt: snapshot.capturedAt, quarantinedAsAnomaly: true };
    saveJson(path.join(config.dataDir, "state.json"), state);
    console.warn(
      `[${snapshot.date || "unknown"}] ${snapshot.campaignKey}: ${path.basename(file)} is ${yearGap} years ahead of the last tracked date (${lastDate}) - ` +
        `quarantined to anomalies.jsonl instead of the real ledger (looks like a reloaded/test autosave, not continuous play). ` +
        `Run tools/campaign-ledger-doctor.js list to review it, or its promote command if this jump was actually intentional.`
    );
    return true;
  }

  // A snapshot chronologically at-or-behind what's already tracked can
  // still happen even with parallel parsing (a source saving fast enough
  // to cycle its rotation slots can hand the recorder content out of
  // strict chronological order relative to when it actually gets read) -
  // this USED to drop the snapshot entirely, which silently lost real
  // data (a war could start and conclude within a stretch the recorder
  // never got credit for). It's now always saved to snapshots.jsonl -
  // every consumer that reads the ledger already re-sorts by date
  // (buildDepartureDates(), latestSnapshot selection, etc. in
  // js/llama-score.js), so an out-of-order entry in the file causes no
  // harm there - it's just not fed into the war-start/update/disappeared
  // diffing below, since that compares THIS snapshot's war list against
  // the CURRENT (more advanced) active-war state, and an out-of-order
  // snapshot would produce nonsense events (a war "disappearing" that's
  // actually still ongoing - this particular snapshot just predates the
  // point where the recorder already knows it existed). Any war this
  // snapshot could have taught us something new about will still get
  // picked up once a properly-ordered later snapshot arrives.
  if (lastDate && compareDates(snapshot.date, lastDate) <= 0) {
    appendJsonl(campaignSnapshotsFile(config, snapshot.campaignKey), snapshot);
    state.files[file] = { mtimeMs: stat.mtimeMs, size: stat.size, hash };
    state.hashes[hash] = { file: path.basename(file), date: snapshot.date, capturedAt: snapshot.capturedAt, outOfOrderThan: lastDate };
    pruneStaleCampaignState(state, config, snapshot.campaignKey);
    saveJson(path.join(config.dataDir, "state.json"), state);
    console.log(
      `[${snapshot.date || "unknown"}] ${snapshot.campaignKey}: ${path.basename(file)} saved out of order (latest known is ${lastDate}) - not used for war-event tracking`
    );
    return true;
  }
  const { events, currentWars } = classifyEvents(previousWars, snapshot);
  appendJsonl(campaignSnapshotsFile(config, snapshot.campaignKey), snapshot);
  for (const event of events) appendJsonl(campaignEventsFile(config, snapshot.campaignKey), event);

  let archivedTo = null;
  if (shouldArchive(events, snapshot, state, config)) archivedTo = archiveSave(file, snapshot, config);

  state.files[file] = { mtimeMs: stat.mtimeMs, size: stat.size, hash };
  state.hashes[hash] = { file: path.basename(file), date: snapshot.date, capturedAt: snapshot.capturedAt, archivedTo };
  state.activeWarsByCampaign[snapshot.campaignKey] = currentWars;
  state.lastDateByCampaign[snapshot.campaignKey] = snapshot.date;
  delete state.activeWars;
  state.lastSnapshot = { hash, date: snapshot.date, file: path.basename(file), campaignKey: snapshot.campaignKey, warCount: snapshot.wars.length };
  pruneStaleCampaignState(state, config, snapshot.campaignKey);
  saveJson(path.join(config.dataDir, "state.json"), state);

  const archiveNote = archivedTo ? " archived" : "";
  console.log(`[${snapshot.date || "unknown"}] ${snapshot.campaignKey}: ${path.basename(file)}: ${snapshot.wars.length} wars, ${events.length} events${archiveNote}`);
  return true;
}

// Runs one save's read+hash+parse (parse-worker.js) on a worker thread
// instead of blocking the main thread. Node's zlib decompression here is the
// SYNCHRONOUS API (inflateRawSync) - fully blocking, not just single-
// threaded-but-yielding - so parsing N files back-to-back on the main
// thread always took N x ~2.3s no matter how often scan() itself was
// called. See parseFilesInParallel() below for why that mattered.
function parseSaveInWorker(file, config) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "parse-worker.js"), {
      workerData: { file, playerWarsOnly: !!config.playerWarsOnly },
    });
    let settled = false;
    worker.once("message", (msg) => {
      settled = true;
      worker.terminate();
      if (msg.ok) resolve({ hash: msg.hash, result: msg.result });
      else {
        const err = new Error(msg.error);
        err.code = msg.code;
        reject(err);
      }
    });
    worker.once("error", (err) => {
      if (settled) return;
      worker.terminate();
      reject(err);
    });
  });
}

// Bounded to a handful of threads (not one per file) so a large backlog
// doesn't spawn dozens of workers at once - CPU count minus one leaves a
// core free for the main thread's own bookkeeping (sorting, writing jsonl,
// updating state.json).
const MAX_PARSE_WORKERS = Math.max(1, Math.min(4, os.cpus().length - 1));

// Parses every candidate file CONCURRENTLY across a small worker pool
// instead of one at a time. Matters specifically when a save folder is
// autosaving fast: the old sequential loop could take 10+ seconds to drain
// a batch of several new files, and the game keeps rotating its autosave
// slots the entire time - a slot could get overwritten again before the
// recorder ever got around to reading it, which is what produced the
// "skipped; older than latest" messages even after lowering pollMs (that
// only shortened the wait BETWEEN scans, not how long a single scan's
// batch took to drain). Confirmed the underlying chronological sort/dedup
// logic itself was already correct (a frozen, isolated single-file test
// scan came out perfectly ordered) - this is purely a throughput fix.
async function parseFilesInParallel(candidates, config) {
  const results = [];
  let nextIndex = 0;
  async function runSlot() {
    while (nextIndex < candidates.length) {
      const { file, stat, forceModifierStateRefresh } = candidates[nextIndex++];
      try {
        const { hash, result } = await parseSaveInWorker(file, config);
        const date = result.metadata && result.metadata.date;
        results.push({ file, stat, hash, result, date, forceModifierStateRefresh });
      } catch (err) {
        if (!err || !["ENOENT", "EPERM", "EBUSY"].includes(err.code)) {
          console.warn(`Could not process ${path.basename(file)}: ${err.message}`);
        }
      }
    }
  }
  const slotCount = Math.max(1, Math.min(MAX_PARSE_WORKERS, candidates.length));
  await Promise.all(Array.from({ length: slotCount }, runSlot));
  return results;
}

async function scan(config, state) {
  ensureDir(config.dataDir);
  const saves = listAutosaves(config).sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);

  // On a modifierState schema bump, refresh EVERY currently-recorded
  // campaign's own most-recent save once - not just whichever save happens
  // to be globally newest right now. `listAutosaves` scopes to the active
  // campaignMode (in the common "latest" mode, that's only the single
  // currently-latest campaign's files), so picking just one global file here
  // left every OTHER already-recorded campaign's ledger permanently stuck on
  // whatever modifierState shape existed the last time ITS save actually
  // changed - confirmed real on a real multi-campaign install (a campaign not
  // currently being played never got its lawHistory/societalValues/character
  // traits backfilled, even though the parser already produces them
  // correctly on a fresh parse). `campaignMode: "all"` here is scoped to just
  // this one-time file selection, not a persistent config change.
  const refreshFiles = new Set();
  if (state.modifierStateSchemaVersion !== MODIFIER_STATE_SCHEMA_VERSION) {
    const newestPerCampaign = new Map();
    for (const entry of listAutosaves(Object.assign({}, config, { campaignMode: "all" }))) {
      const key = campaignKeyFromFile(entry.file);
      // Only backfill campaigns this recorder has already recorded at least
      // one snapshot for - a schema bump refreshing already-known data is
      // very different from silently starting to track dozens of old,
      // never-before-seen campaigns just because their save files happen to
      // still sit in the save folder.
      if (!state.lastDateByCampaign || !state.lastDateByCampaign[key]) continue;
      const existing = newestPerCampaign.get(key);
      if (!existing || entry.stat.mtimeMs > existing.stat.mtimeMs) newestPerCampaign.set(key, entry);
    }
    for (const entry of newestPerCampaign.values()) refreshFiles.add(entry.file);
  }

  const savesByFile = new Map(saves.map((entry) => [entry.file, entry]));
  for (const file of refreshFiles) {
    if (!savesByFile.has(file)) {
      const stat = tryStat(file);
      if (stat) savesByFile.set(file, { file, stat });
    }
  }

  const candidates = [];
  for (const entry of savesByFile.values()) {
    const file = entry.file;
    const stat = tryStat(file) || entry.stat;
    if (!stat) continue;
    const age = Date.now() - stat.mtimeMs;
    if (age < config.stableMs || stat.size <= 0) continue;
    const forceModifierStateRefresh = refreshFiles.has(file);
    const known = state.files[file];
    if (!forceModifierStateRefresh && known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) continue;
    candidates.push({ file, stat, forceModifierStateRefresh });
  }

  const parsed = await parseFilesInParallel(candidates, config);
  parsed.sort((a, b) => compareDates(a.date, b.date) || a.stat.mtimeMs - b.stat.mtimeMs);

  let processed = 0;
  const refreshFilesRemaining = new Set(refreshFiles);
  for (const item of parsed) {
    try {
      if (await processParsedFile(item.file, item.stat, item.hash, item.result, config, state, item.forceModifierStateRefresh)) {
        processed++;
        if (item.forceModifierStateRefresh) refreshFilesRemaining.delete(item.file);
      }
    } catch (err) {
      console.warn(`Could not process ${path.basename(item.file)}: ${err.message}`);
    }
  }
  // Only mark the schema backfill "done" once every campaign refreshFiles
  // identified this tick actually succeeded - previously this flipped as
  // soon as the FIRST file in the whole batch (refresh or not) processed
  // successfully, so one campaign throwing mid-batch (a parse exception
  // specific to that older save, or any other per-file failure) got silently
  // skipped by console.warn above and then never retried on any later tick,
  // since this guard would already read as satisfied. A campaign with
  // nothing left to backfill (refreshFilesRemaining empty, including the
  // trivial case where refreshFiles was empty to begin with) is the only
  // condition that should stop scan() from re-attempting it.
  if (state.modifierStateSchemaVersion !== MODIFIER_STATE_SCHEMA_VERSION && refreshFilesRemaining.size === 0) {
    state.modifierStateSchemaVersion = MODIFIER_STATE_SCHEMA_VERSION;
    saveJson(path.join(config.dataDir, "state.json"), state);
  }

  // Compact every OTHER campaign's ledger to .gz - `saves` (computed above,
  // before the stability/mtime filtering) already reflects every campaign
  // this config's campaignMode considers in scope, so anything NOT in that
  // set is definitely not getting an appendJsonl() call this tick (or any
  // tick until it's back in scope, at which point processParsedFile's
  // decompactCampaignLedger call undoes this). Cheap once already compacted
  // (compactCampaignLedger no-ops when there's no plain file left), so
  // running this every tick rather than on some schedule is fine.
  const inScopeKeys = new Set(saves.map((entry) => safeCampaignKey(campaignKeyFromFile(entry.file))));
  if (fs.existsSync(config.campaignsDir)) {
    for (const d of fs.readdirSync(config.campaignsDir, { withFileTypes: true })) {
      if (!d.isDirectory() || inScopeKeys.has(d.name)) continue;
      try {
        compactCampaignLedger(config, d.name);
      } catch (err) {
        console.warn(`Could not compact ledger for ${d.name}: ${err.message}`);
      }
    }
  }

  return processed;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const config = readConfig(args);
  ensureDir(config.dataDir);
  const stateFile = path.join(config.dataDir, "state.json");
  const state = loadJson(stateFile, { files: {}, hashes: {}, activeWarsByCampaign: {}, checkpoints: {}, lastSnapshot: null, lastDateByCampaign: {} });
  state.activeWarsByCampaign = state.activeWarsByCampaign || {};
  state.lastDateByCampaign = state.lastDateByCampaign || {};
  migrateLegacyLedgerIfNeeded(config);
  hydrateStateFromSnapshots(config, state);

  console.log("🪓 Llama Score Logging Machine");
  console.log(`Watching: ${config.saveDir}`);
  console.log(`Output:   ${config.dataDir}`);

  await scan(config, state);
  if (args.once) return;

  async function pollLoop() {
    await new Promise((resolve) => setTimeout(resolve, config.pollMs));
    try {
      await scan(config, state);
    } catch (err) {
      console.warn(`Scan failed: ${err.message}`);
    }
    pollLoop();
  }
  pollLoop();
}

// Exposed so the desktop dashboard (llama-dashboard/main.js) can drive the
// exact same scan loop the CLI uses - embedding it directly instead of
// reimplementing save-watching/parsing/ledger-writing a second time, or
// shelling out to a separate `node` process the dashboard would have no
// control over. Purely additive - doesn't change any CLI behavior below.
module.exports = {
  DEFAULT_CONFIG,
  readConfig,
  ensureDir,
  loadJson,
  saveJson,
  migrateLegacyLedgerIfNeeded,
  hydrateStateFromSnapshots,
  scan,
  campaignKeyFromFile,
  campaignDir,
  campaignSnapshotsFile,
  campaignEventsFile,
  campaignAnomaliesFile,
  readLedgerText,
  statLedgerFile,
  compactCampaignLedger,
  decompactCampaignLedger,
  classifyEvents,
  dateKey,
  compareDates,
  buildSnapshot,
  processParsedFile,
};

// Guarded so this file can be require()'d (e.g. from a test script) without
// immediately scanning the save folder and starting the poll loop - without
// this, main() ran unconditionally at module load, which is also what made
// it awkward to load internals for a one-off diagnostic script.
if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message || String(err));
    process.exit(1);
  });
}
