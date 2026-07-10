#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const Clausewitz = require("../js/clausewitz.js");
const ClausewitzBinary = require("../js/clausewitz-binary.js");

const DEFAULT_CONFIG = {
  saveDir: "C:\\Users\\samca\\Documents\\Paradox Interactive\\Europa Universalis V\\save games",
  dataDir: "./data",
  pollMs: 15000,
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
    "Llama Score Automatic Logging Machine",
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

function saveJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
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

  if (formatCode === "00") {
    const text = bytes.toString("utf8");
    return { hash, result: Clausewitz.parseSave(text, { includeWars: true, includeLocations: false, playerWarsOnly: !!config.playerWarsOnly }) };
  }

  if (formatCode === "03") {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return { hash, result: await ClausewitzBinary.parseCompressedSave(buffer, { includeWars: true, includeLocations: false, playerWarsOnly: !!config.playerWarsOnly }) };
  }

  throw new Error(`Unsupported save format code ${formatCode}`);
}

function countrySummary(c) {
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
  };
}

function allCountryLookup(countries) {
  const lookup = {};
  for (const c of countries || []) {
    if (typeof c.number === "number") lookup[c.number] = countrySummary(c);
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

function economicOutcomeSignal(economy) {
  if (!economy || !economy.Attacker || !economy.Defender) return null;
  const aGold = economy.Attacker.goldDelta;
  const dGold = economy.Defender.goldDelta;
  const aPrestige = economy.Attacker.prestigeDelta;
  const dPrestige = economy.Defender.prestigeDelta;
  const aLocations = economy.Attacker.locationDelta;
  const dLocations = economy.Defender.locationDelta;
  const signals = [];

  if (typeof aLocations === "number" && typeof dLocations === "number") {
    const spread = aLocations - dLocations;
    if (Math.abs(spread) >= 2 && Math.sign(aLocations) !== Math.sign(dLocations)) {
      signals.push({
        winnerSide: spread > 0 ? "Attacker" : "Defender",
        loserSide: spread > 0 ? "Defender" : "Attacker",
        reason: "post-war-land-transfer",
        strength: Math.abs(spread) * 1000,
      });
    }
  } else if (typeof aLocations === "number" || typeof dLocations === "number") {
    const side = typeof aLocations === "number" ? "Attacker" : "Defender";
    const value = typeof aLocations === "number" ? aLocations : dLocations;
    if (Math.abs(value) >= 1) {
      signals.push({
        winnerSide: value > 0 ? side : side === "Attacker" ? "Defender" : "Attacker",
        loserSide: value > 0 ? (side === "Attacker" ? "Defender" : "Attacker") : side,
        reason: "post-war-land-transfer",
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

  if (typeof aPrestige === "number" && typeof dPrestige === "number") {
    const spread = aPrestige - dPrestige;
    if (Math.abs(spread) >= 5) {
      signals.push({
        winnerSide: spread > 0 ? "Attacker" : "Defender",
        loserSide: spread > 0 ? "Defender" : "Attacker",
        reason: "post-war-prestige-swing",
        strength: Math.abs(spread) * 10,
      });
    }
  }

  if (!signals.length) return null;
  signals.sort((a, b) => b.strength - a.strength);
  return signals[0];
}

function inferOutcome(war, disappeared, economy) {
  const aScore = war.attackerScore;
  const dScore = war.defenderScore;
  if (typeof aScore === "number" && typeof dScore === "number" && aScore !== dScore) {
    return {
      winnerSide: aScore > dScore ? "Attacker" : "Defender",
      loserSide: aScore > dScore ? "Defender" : "Attacker",
      confidence: disappeared ? "medium" : "low",
      reason: "last-known-war-score",
      attackerScore: aScore,
      defenderScore: dScore,
    };
  }
  if (typeof aScore === "number" && aScore !== 0 && typeof dScore !== "number") {
    return {
      winnerSide: aScore > 0 ? "Attacker" : "Defender",
      loserSide: aScore > 0 ? "Defender" : "Attacker",
      confidence: disappeared ? "medium" : "low",
      reason: "last-known-single-sided-attacker-score",
      attackerScore: aScore,
      defenderScore: dScore,
    };
  }
  if (typeof dScore === "number" && dScore !== 0 && typeof aScore !== "number") {
    return {
      winnerSide: dScore > 0 ? "Defender" : "Attacker",
      loserSide: dScore > 0 ? "Attacker" : "Defender",
      confidence: disappeared ? "medium" : "low",
      reason: "last-known-single-sided-defender-score",
      attackerScore: aScore,
      defenderScore: dScore,
    };
  }

  const economicSignal = economicOutcomeSignal(economy);
  if (economicSignal) {
    return {
      winnerSide: economicSignal.winnerSide,
      loserSide: economicSignal.loserSide,
      confidence: "medium",
      reason: economicSignal.reason,
      attackerScore: aScore,
      defenderScore: dScore,
    };
  }

  const occ = war.occupation || {};
  if (typeof occ.attackerLocations === "number" && typeof occ.defenderLocations === "number" && occ.attackerLocations !== occ.defenderLocations) {
    return {
      winnerSide: occ.attackerLocations > occ.defenderLocations ? "Attacker" : "Defender",
      loserSide: occ.attackerLocations > occ.defenderLocations ? "Defender" : "Attacker",
      confidence: "low",
      reason: "occupied-location-count",
      attackerScore: aScore,
      defenderScore: dScore,
    };
  }

  return {
    winnerSide: null,
    loserSide: null,
    confidence: "unknown",
    reason: disappeared ? "war-disappeared-without-decisive-signal" : "active-or-tied",
    attackerScore: aScore,
    defenderScore: dScore,
  };
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
  const countryLookup = {};
  for (const n of interestingCountries) {
    const c = countryByNumber.get(n);
    if (c) countryLookup[n] = countrySummary(c);
  }
  const playerCountries = countries.filter((c) => c.players && c.players.length).map(countrySummary);
  const economyCountries = config.storeAllEconomyCountries ? allCountryLookup(countries) : countryLookup;
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
  if (lastDate && compareDates(snapshot.date, lastDate) <= 0) {
    state.files[file] = { mtimeMs: stat.mtimeMs, size: stat.size, hash };
    state.hashes[hash] = { file: path.basename(file), date: snapshot.date, capturedAt: snapshot.capturedAt, skippedOlderThan: lastDate };
    saveJson(path.join(config.dataDir, "state.json"), state);
    console.log(`[${snapshot.date || "unknown"}] ${snapshot.campaignKey}: ${path.basename(file)} skipped; older than latest ${lastDate}`);
    return false;
  }
  const { events, currentWars } = classifyEvents(previousWars, snapshot);
  ensureDir(campaignDir(config, snapshot.campaignKey));
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
  saveJson(path.join(config.dataDir, "state.json"), state);

  const archiveNote = archivedTo ? " archived" : "";
  console.log(`[${snapshot.date || "unknown"}] ${snapshot.campaignKey}: ${path.basename(file)}: ${snapshot.wars.length} wars, ${events.length} events${archiveNote}`);
  return true;
}

async function scan(config, state) {
  ensureDir(config.dataDir);
  const saves = listAutosaves(config).sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
  const parsed = [];
  let processed = 0;
  for (const entry of saves) {
    const file = entry.file;
    try {
      const stat = tryStat(file);
      if (!stat) continue;
      const age = Date.now() - stat.mtimeMs;
      if (age < config.stableMs || stat.size <= 0) continue;
      const known = state.files[file];
      if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) continue;
      const { hash, result } = await readAndParseSave(file, config);
      const date = result.metadata && result.metadata.date;
      parsed.push({ file, stat, hash, result, date });
    } catch (err) {
      if (!err || !["ENOENT", "EPERM", "EBUSY"].includes(err.code)) {
        console.warn(`Could not process ${path.basename(file)}: ${err.message}`);
      }
    }
  }
  parsed.sort((a, b) => compareDates(a.date, b.date) || a.stat.mtimeMs - b.stat.mtimeMs);
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

  console.log("Llama Score Automatic Logging Machine");
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

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
