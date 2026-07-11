#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULT_DATA_DIR = path.join(__dirname, "..", "llama-score-automatic-logging-machine", "data");
const DEFAULT_REST_CHUNK_SIZE = 25;
const TABLE_CHUNK_SIZES = {
  eu5_campaign_snapshots: 1,
  eu5_war_events: 100,
};

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.replace(/^\uFEFF/, "").match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function usage() {
  return [
    "Import recorder JSONL ledgers into Supabase.",
    "",
    "Usage:",
    "  node scripts/import-llama-ledgers-to-supabase.js --dry-run",
    "  node scripts/import-llama-ledgers-to-supabase.js --campaign <campaign-key>",
    "",
    "Options:",
    "  --data-dir <dir>   Recorder data directory. Defaults to llama-score-automatic-logging-machine/data.",
    "  --campaign <key>   Import only one campaign.",
    "  --dry-run          Parse and summarize locally without writing to Supabase.",
    "  --url <url>        Supabase project URL. Defaults to SUPABASE_URL.",
    "  --key <key>        Supabase service role key. Defaults to SUPABASE_SERVICE_ROLE_KEY.",
    "",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { dataDir: DEFAULT_DATA_DIR, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--data-dir") args.dataDir = argv[++i];
    else if (arg === "--campaign") args.campaign = argv[++i];
    else if (arg === "--url") args.url = argv[++i];
    else if (arg === "--key") args.key = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  args.dataDir = path.resolve(process.cwd(), args.dataDir);
  args.url = args.url || process.env.SUPABASE_URL;
  args.key = args.key || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return args;
}

function readJsonl(file, onRecord) {
  if (!fs.existsSync(file)) return 0;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      onRecord(JSON.parse(line), i + 1);
      count++;
    } catch (err) {
      console.warn(`Skipping malformed JSONL line ${file}:${i + 1}: ${err.message}`);
    }
  }
  return count;
}

function hashText(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function toIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean).map(String))].sort((a, b) => a.localeCompare(b));
}

function campaignDirs(dataDir, requestedCampaign) {
  const campaignsDir = path.join(dataDir, "campaigns");
  if (!fs.existsSync(campaignsDir)) {
    throw new Error(`No campaigns directory found at ${campaignsDir}`);
  }
  return fs.readdirSync(campaignsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !requestedCampaign || name === requestedCampaign)
    .sort()
    .map((name) => ({ campaignKey: name, dir: path.join(campaignsDir, name) }));
}

function loadCampaign(campaignKey, dir) {
  const snapshots = [];
  const events = [];
  const sourceHashToCapturedAt = new Map();

  readJsonl(path.join(dir, "snapshots.jsonl"), (snapshot, lineNumber) => {
    const key = snapshot.campaignKey || campaignKey;
    const row = {
      campaign_key: key,
      source_hash: snapshot.sourceHash || hashText(`${key}:snapshot:${lineNumber}`),
      line_number: lineNumber,
      captured_at: toIso(snapshot.capturedAt),
      source_file: snapshot.sourceFile || null,
      game_date: snapshot.date || null,
      game_year: Number.isFinite(snapshot.year) ? snapshot.year : null,
      playthrough_name: snapshot.playthroughName || null,
      game_version: snapshot.gameVersion || null,
      player_country_count: Array.isArray(snapshot.playerCountries) ? snapshot.playerCountries.length : 0,
      war_count: Array.isArray(snapshot.wars) ? snapshot.wars.length : 0,
      war_filter: snapshot.warFilter || null,
      snapshot,
    };
    sourceHashToCapturedAt.set(row.source_hash, row.captured_at);
    snapshots.push(row);
  });

  readJsonl(path.join(dir, "war-events.jsonl"), (event, lineNumber) => {
    const sourceHash = event.sourceHash || null;
    const eventId = hashText(`${campaignKey}:event:${lineNumber}:${sourceHash || ""}:${event.type || ""}:${event.warNumber || ""}`);
    events.push({
      event_id: eventId,
      campaign_key: campaignKey,
      source_hash: sourceHash,
      line_number: lineNumber,
      event_type: event.type || null,
      war_number: Number.isFinite(event.warNumber) ? event.warNumber : null,
      game_date: event.date || null,
      event,
      _captured_at: sourceHash ? sourceHashToCapturedAt.get(sourceHash) || null : null,
    });
  });

  const latest = snapshots
    .filter((row) => row.captured_at)
    .slice()
    .sort((a, b) => a.captured_at.localeCompare(b.captured_at))
    .pop() || snapshots[snapshots.length - 1] || null;
  const latestPlayers = latest && Array.isArray(latest.snapshot.playerCountries) ? latest.snapshot.playerCountries : [];
  const playerNames = uniqueSorted(latestPlayers.flatMap((country) => Array.isArray(country.players) ? country.players : []));

  const campaign = {
    campaign_key: campaignKey,
    playthrough_name: latest ? latest.playthrough_name : null,
    game_version: latest ? latest.game_version : null,
    latest_game_date: latest ? latest.game_date : null,
    latest_game_year: latest ? latest.game_year : null,
    latest_captured_at: latest ? latest.captured_at : null,
    latest_source_hash: latest ? latest.source_hash : null,
    snapshot_count: snapshots.length,
    event_count: events.length,
    player_names: playerNames,
    latest_players: latestPlayers,
  };

  for (const event of events) delete event._captured_at;
  return { campaign, snapshots, events };
}

function restUrl(baseUrl, table, onConflict) {
  const url = new URL(`/rest/v1/${table}`, baseUrl);
  if (onConflict) url.searchParams.set("on_conflict", onConflict);
  return url;
}

async function upsertRows(baseUrl, key, table, rows, onConflict) {
  if (!rows.length) return;
  const chunkSize = TABLE_CHUNK_SIZES[table] || DEFAULT_REST_CHUNK_SIZE;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const response = await fetch(restUrl(baseUrl, table, onConflict), {
      method: "POST",
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(chunk),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Supabase upsert failed for ${table}: HTTP ${response.status} ${text}`);
    }
  }
}

async function main() {
  loadEnvFile(path.join(__dirname, "..", ".env"));
  loadEnvFile(path.join(__dirname, "..", ".env.local"));

  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  if (!args.dryRun && (!args.url || !args.key)) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required unless --dry-run is set.");
  }

  const loaded = campaignDirs(args.dataDir, args.campaign).map(({ campaignKey, dir }) => loadCampaign(campaignKey, dir));
  if (args.campaign && loaded.length === 0) {
    throw new Error(`Campaign not found: ${args.campaign}`);
  }

  const totals = loaded.reduce(
    (acc, item) => {
      acc.campaigns += 1;
      acc.snapshots += item.snapshots.length;
      acc.events += item.events.length;
      return acc;
    },
    { campaigns: 0, snapshots: 0, events: 0 }
  );

  console.table(loaded.map((item) => ({
    campaign: item.campaign.campaign_key,
    snapshots: item.snapshots.length,
    events: item.events.length,
    latest: item.campaign.latest_game_date || "",
    players: item.campaign.player_names.join(", "),
  })));

  if (args.dryRun) {
    console.log(`Dry run complete: ${totals.campaigns} campaign(s), ${totals.snapshots} snapshot(s), ${totals.events} event(s).`);
    return;
  }

  await upsertRows(args.url, args.key, "eu5_campaigns", loaded.map((item) => item.campaign), "campaign_key");
  for (const item of loaded) {
    await upsertRows(args.url, args.key, "eu5_campaign_snapshots", item.snapshots, "campaign_key,source_hash");
    await upsertRows(args.url, args.key, "eu5_war_events", item.events, "event_id");
  }
  console.log(`Imported ${totals.campaigns} campaign(s), ${totals.snapshots} snapshot(s), ${totals.events} event(s).`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
