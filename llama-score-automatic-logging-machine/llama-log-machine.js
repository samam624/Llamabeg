#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { Worker } = require("worker_threads");

const Clausewitz = require("../js/clausewitz.js");
const ClausewitzBinary = require("../js/clausewitz-binary.js");

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

function campaignArchiveDir(config, campaignKey) {
  return path.join(campaignDir(config, campaignKey), "archive");
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
    return { hash, result: Clausewitz.parseSave(text, { includeWars: true, includeLocations: true, playerWarsOnly: !!config.playerWarsOnly }) };
  }

  if (formatCode === "03") {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return { hash, result: await ClausewitzBinary.parseCompressedSave(buffer, { includeWars: true, includeLocations: true, playerWarsOnly: !!config.playerWarsOnly }) };
  }

  throw new Error(`Unsupported save format code ${formatCode}`);
}

// overlordOf (a Map<subjectNumber, overlordNumber> built from
// result.dependencies - see extractDependencyFields in js/clausewitz.js)
// lets the Llama/Alpaca Score engine tell a war's real sovereign
// belligerents apart from vassals/subjects dragged along for the ride -
// see excludeSubjectsOfPresentOverlords() in js/llama-score.js for why that
// matters for PVE scoring specifically.
function countrySummary(c, overlordOf) {
  const overlord = overlordOf ? overlordOf.get(c.number) : undefined;
  return {
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
    gpRank: c.greatPowerRank,
    scorePlace: c.scorePlace,
    locationCount: c.locationCount,
    capital: c.capital,
    overlord: typeof overlord === "number" ? overlord : null,
  };
}

function buildOverlordLookup(result) {
  const map = new Map();
  for (const dep of result.dependencies || []) {
    if (typeof dep.overlord === "number" && typeof dep.subject === "number") map.set(dep.subject, dep.overlord);
  }
  return map;
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

function countriesBySide(participants) {
  const sides = { Attacker: [], Defender: [], Other: [] };
  for (const p of participants || []) {
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

function sideEconomyDeltas(war, beforeCountries, afterCountries) {
  if (!war || !beforeCountries || !afterCountries) return null;
  const sides = war.sides || countriesBySide(war.participants || []);
  const result = {};
  for (const side of ["Attacker", "Defender"]) {
    const countries = sides[side] || [];
    const entries = [];
    let gold = 0;
    let prestige = 0;
    let locations = 0;
    let goldCount = 0;
    let prestigeCount = 0;
    let locationCount = 0;
    for (const country of countries) {
      const before = beforeCountries[country];
      const after = afterCountries[country];
      if (!before || !after) continue;
      const goldDelta = numDelta(after.gold, before.gold);
      const prestigeDelta = numDelta(after.prestige, before.prestige);
      const locationDelta = numDelta(after.locationCount, before.locationCount);
      entries.push({ country, goldDelta, prestigeDelta, locationDelta });
      if (typeof goldDelta === "number") {
        gold += goldDelta;
        goldCount++;
      }
      if (typeof prestigeDelta === "number") {
        prestige += prestigeDelta;
        prestigeCount++;
      }
      if (typeof locationDelta === "number") {
        locations += locationDelta;
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
function principalCountrySet(value) {
  const set = new Set();
  if (typeof value === "number") set.add(value);
  else if (Array.isArray(value)) for (const n of value) if (typeof n === "number") set.add(n);
  return set;
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

function economicOutcomeSignal(war, economy) {
  if (!economy || !economy.Attacker || !economy.Defender) return null;
  const attackerPrincipals = principalCountrySet(war.originalAttacker);
  const defenderPrincipals = principalCountrySet(war.originalDefenders);

  const aLoc = resolveSideField(economy.Attacker, attackerPrincipals, "locationDelta");
  const dLoc = resolveSideField(economy.Defender, defenderPrincipals, "locationDelta");
  const aGoldR = resolveSideField(economy.Attacker, attackerPrincipals, "goldDelta");
  const dGoldR = resolveSideField(economy.Defender, defenderPrincipals, "goldDelta");

  const aGold = aGoldR.value;
  const dGold = dGoldR.value;
  const aLocations = aLoc.value;
  const dLocations = dLoc.value;
  const signals = [];

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
    if (aLocations !== 0 && dLocations !== 0 && Math.abs(spread) >= 2 && Math.sign(aLocations) !== Math.sign(dLocations)) {
      const clean = aLoc.usedPrincipal && dLoc.usedPrincipal;
      signals.push({
        winnerSide: spread > 0 ? "Attacker" : "Defender",
        loserSide: spread > 0 ? "Defender" : "Attacker",
        reason: clean ? "post-war-land-transfer" : "post-war-land-transfer-coalition",
        strength: Math.abs(spread) * 1000,
      });
    }
  } else if (typeof aLocations === "number" || typeof dLocations === "number") {
    const side = typeof aLocations === "number" ? "Attacker" : "Defender";
    const value = typeof aLocations === "number" ? aLocations : dLocations;
    const clean = side === "Attacker" ? aLoc.usedPrincipal : dLoc.usedPrincipal;
    if (Math.abs(value) >= 1) {
      signals.push({
        winnerSide: value > 0 ? side : side === "Attacker" ? "Defender" : "Attacker",
        loserSide: value > 0 ? (side === "Attacker" ? "Defender" : "Attacker") : side,
        reason: clean ? "post-war-land-transfer" : "post-war-land-transfer-coalition",
        strength: Math.abs(value) * 1000,
      });
    }
  }

  if (typeof aGold === "number" && typeof dGold === "number") {
    const spread = aGold - dGold;
    if (Math.abs(spread) >= 100) {
      signals.push({
        winnerSide: spread > 0 ? "Attacker" : "Defender",
        loserSide: spread > 0 ? "Defender" : "Attacker",
        reason: "post-war-treasury-swing",
        strength: Math.abs(spread),
      });
    }
  } else if (typeof aGold === "number" || typeof dGold === "number") {
    const side = typeof aGold === "number" ? "Attacker" : "Defender";
    const value = typeof aGold === "number" ? aGold : dGold;
    if (value > 100) {
      signals.push({
        winnerSide: side,
        loserSide: side === "Attacker" ? "Defender" : "Attacker",
        reason: "post-war-treasury-gain",
        strength: value,
      });
    }
  }

  // Prestige deliberately NOT considered here anymore - see prestigeSignal
  // below and inferOutcome's comment for why it's a contributing factor
  // only, never decisive on its own.

  if (!signals.length) return null;
  signals.sort((a, b) => b.strength - a.strength);
  return signals[0];
}

// Prestige swing alone (diplomatic reputation, not land or gold) - kept as a
// CONTRIBUTING factor only (see inferOutcome), never decisive: unlike
// land/gold, prestige moves constantly for reasons that have nothing to do
// with a specific war (tech, religion, other diplomacy elsewhere), so
// trusting it to crown a winner risks the exact same false-positive shape
// economicOutcomeSignal's own nonzero-both-sides fix just had to correct
// for location counts.
function prestigeSignal(war, economy) {
  if (!economy || !economy.Attacker || !economy.Defender) return null;
  const attackerPrincipals = principalCountrySet(war.originalAttacker);
  const defenderPrincipals = principalCountrySet(war.originalDefenders);
  const aPrestige = resolveSideField(economy.Attacker, attackerPrincipals, "prestigeDelta").value;
  const dPrestige = resolveSideField(economy.Defender, defenderPrincipals, "prestigeDelta").value;
  if (typeof aPrestige !== "number" || typeof dPrestige !== "number") return null;
  const spread = aPrestige - dPrestige;
  if (Math.abs(spread) < 5) return null;
  return { winnerSide: spread > 0 ? "Attacker" : "Defender" };
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

function inferOutcome(war, disappeared, economy) {
  const aScore = war.attackerScore;
  const dScore = war.defenderScore;
  const lossSignal = battleLossSignal(war);
  const scoreSignal =
    typeof aScore === "number" && typeof dScore === "number" && aScore !== dScore
      ? { winnerSide: aScore > dScore ? "Attacker" : "Defender" }
      : null;
  const prestSignal = prestigeSignal(war, economy);

  // Per the user's call (js/llama-score.js's copy of this function has the
  // full writeup, kept in sync deliberately): war score, prestige, and
  // battle losses never decide a winner on their own anymore - each one
  // moves for reasons that don't reliably track who actually won THIS
  // specific war (a two-sided war score is frequently a partial-clear
  // artifact from EU5's own end-of-war cleanup; prestige swings constantly
  // for reasons unrelated to a specific war; a winning invader can still
  // rack up heavy battle losses). Only land or gold actually changing hands
  // between the two principals (economicOutcomeSignal) decides who won;
  // everything else is attached below as contributingFactors so the
  // reasoning stays visible/auditable without ever being trusted to pick a
  // side by itself - not even when several of them happen to agree.
  function finalize(result) {
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
    if (prestSignal) contributingFactors.push({ signal: "prestige-swing", winnerSide: prestSignal.winnerSide });
    if (lossSignal) contributingFactors.push({ signal: "battle-losses", winnerSide: lossSignal.winnerSide });
    return { ...result, confidence, lossSignalAgrees, contributingFactors, attackerScore: aScore, defenderScore: dScore };
  }

  // The only decisive check in this function: before/after territory and
  // treasury change, restricted to the war's two original principals (see
  // economicOutcomeSignal's own comments for the nonzero-both-sides fix and
  // the principal/coalition split). Land transfer gets "high" confidence
  // (about as unambiguous as this game's data gets); a gold-only signal
  // gets "medium" (real, but a country's treasury swings for other reasons
  // too, just less commonly by this much right as a war ends).
  const economicSignal = economicOutcomeSignal(war, economy);
  if (economicSignal) {
    return finalize({
      winnerSide: economicSignal.winnerSide,
      loserSide: economicSignal.loserSide,
      confidence: economicSignal.reason === "post-war-land-transfer" ? "high" : "medium",
      reason: economicSignal.reason,
    });
  }

  // Deliberately NOT falling back to war.occupation (who's occupying more
  // contested territory at the moment the war disappears) here - confirmed
  // wrong on real data twice now (see js/llama-score.js's copy of this
  // function): occupation called 4 of 5 real wars for the wrong side even
  // as the PRIMARY signal. Occupying land mid-war is not the same as
  // keeping it - only the economic/land-transfer signal above (a real
  // before/after comparison) can tell those apart, so this heuristic is
  // retired rather than kept as a lower-confidence guess.

  // No land or gold actually changed hands between the two principals -
  // default to White Peace. War score/prestige/battle-losses are still
  // attached as contributingFactors above for anyone auditing the call, but
  // per the user's call none of them gets to crown a winner on its own - a
  // white peace costs nothing to get right, and the per-row manual override
  // still corrects it if this genuinely was decisive.
  return finalize({
    winnerSide: null,
    loserSide: null,
    confidence: "unknown",
    reason: disappeared ? "war-disappeared-without-decisive-signal" : "active-or-tied",
  });
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
  const countryLookup = {};
  for (const n of interestingCountries) {
    const c = countryByNumber.get(n);
    if (c) countryLookup[n] = countrySummary(c, overlordOf);
  }
  const playerCountries = countries.filter((c) => c.players && c.players.length).map((c) => countrySummary(c, overlordOf));
  const economyCountries = config.storeAllEconomyCountries ? allCountryLookup(countries, overlordOf) : countryLookup;
  return {
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
  };
}

function classifyEvents(previousWars, snapshot) {
  const events = [];
  const current = {};
  const economyCountries = snapshot.economyCountries || snapshot.countries || {};
  for (const war of snapshot.wars) {
    const fp = warFingerprint(war);
    current[war.number] = {
      fingerprint: fp,
      startDate: war.startDate,
      lastSeenDate: snapshot.date,
      lastSnapshotHash: snapshot.sourceHash,
      lastWar: war,
      lastCountries: economyCountries,
    };
    const previous = previousWars[String(war.number)];
    if (!previous) {
      events.push({ type: "war-start", warNumber: war.number, date: snapshot.date, sourceHash: snapshot.sourceHash, war });
    } else if (previous.fingerprint !== fp) {
      events.push({ type: "war-update", warNumber: war.number, date: snapshot.date, sourceHash: snapshot.sourceHash, war });
    }
  }
  for (const [warNumber, previous] of Object.entries(previousWars)) {
    if (!current[warNumber]) {
      const lastWar = previous.lastWar || null;
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
        inferredOutcome: lastWar ? inferOutcome(lastWar, true, economy) : null,
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

function listCampaignSnapshotFiles(config) {
  if (!fs.existsSync(config.campaignsDir)) return [];
  const files = [];
  for (const d of fs.readdirSync(config.campaignsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const file = path.join(config.campaignsDir, d.name, "snapshots.jsonl");
    if (fs.existsSync(file)) files.push(file);
  }
  return files;
}

function hydrateStateFromSnapshots(config, state) {
  const files = listCampaignSnapshotFiles(config);
  if (!files.length) return;
  const latestByCampaign = new Map();
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
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
    if (!state.lastDateByCampaign[campaignKey] || compareDates(snapshot.date, state.lastDateByCampaign[campaignKey]) > 0) {
      state.lastDateByCampaign[campaignKey] = snapshot.date;
    }
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

async function processParsedFile(file, stat, hash, result, config, state) {
  const known = state.files[file];
  if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) return false;
  if (state.hashes[hash]) {
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
      const { file, stat } = candidates[nextIndex++];
      try {
        const { hash, result } = await parseSaveInWorker(file, config);
        const date = result.metadata && result.metadata.date;
        results.push({ file, stat, hash, result, date });
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
  const candidates = [];
  for (const entry of saves) {
    const file = entry.file;
    const stat = tryStat(file);
    if (!stat) continue;
    const age = Date.now() - stat.mtimeMs;
    if (age < config.stableMs || stat.size <= 0) continue;
    const known = state.files[file];
    if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) continue;
    candidates.push({ file, stat });
  }

  const parsed = await parseFilesInParallel(candidates, config);
  parsed.sort((a, b) => compareDates(a.date, b.date) || a.stat.mtimeMs - b.stat.mtimeMs);

  let processed = 0;
  for (const item of parsed) {
    try {
      if (await processParsedFile(item.file, item.stat, item.hash, item.result, config, state)) processed++;
    } catch (err) {
      console.warn(`Could not process ${path.basename(item.file)}: ${err.message}`);
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
