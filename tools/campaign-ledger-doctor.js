#!/usr/bin/env node
"use strict";
// One-command fixes for a recorder campaign's ledger, for when a mistake
// needs undoing - e.g. reloading an old singleplayer save to test
// something, which autosaves under the exact same filename/campaign key as
// the real campaign (see llama-log-machine.js's campaignKeyFromFile) and so
// looks to the recorder like the real campaign just jumped forward decades.
// As of the forward-jump anomaly guard in llama-log-machine.js, a jump like
// that is caught automatically and quarantined to a campaign's
// anomalies.jsonl instead of corrupting snapshots.jsonl/war-events.jsonl -
// this tool is for the two things that guard can't decide on its own:
// permanently discarding a bad jump, or confirming a flagged one was
// actually intentional after all.
//
// IMPORTANT: stop the recorder (the standalone CLI, or the desktop
// Llama Score Dashboard) before running `remove` or `promote` - both
// rewrite the same files the recorder itself reads/writes, and running them
// concurrently risks a lost update.
//
// Usage:
//   node tools/campaign-ledger-doctor.js list <campaign-key> [--data-dir <dir>]
//   node tools/campaign-ledger-doctor.js remove <campaign-key> --after <date> [--data-dir <dir>] [--yes]
//   node tools/campaign-ledger-doctor.js remove <campaign-key> --hash <sourceHashPrefix> [--data-dir <dir>] [--yes]
//   node tools/campaign-ledger-doctor.js promote <campaign-key> --hash <sourceHashPrefix> [--data-dir <dir>] [--yes]
//   node tools/campaign-ledger-doctor.js repair-state <campaign-key> [--data-dir <dir>] [--yes]
//
// `remove`/`promote` are dry runs by default - they print exactly what
// would change and require --yes to actually touch any file. Every real
// change is preceded by an unconditional timestamped backup of the whole
// campaign folder.

const fs = require("fs");
const path = require("path");
const Recorder = require("../llama-score-automatic-logging-machine/llama-log-machine.js");

const DEFAULT_DATA_DIR = path.join(__dirname, "..", "llama-score-automatic-logging-machine", "data");

function usage() {
  return [
    "Usage:",
    "  node tools/campaign-ledger-doctor.js list <campaign-key> [--data-dir <dir>]",
    "  node tools/campaign-ledger-doctor.js remove <campaign-key> --after <date> [--data-dir <dir>] [--yes]",
    "  node tools/campaign-ledger-doctor.js remove <campaign-key> --hash <sourceHashPrefix> [--data-dir <dir>] [--yes]",
    "  node tools/campaign-ledger-doctor.js promote <campaign-key> --hash <sourceHashPrefix> [--data-dir <dir>] [--yes]",
    "  node tools/campaign-ledger-doctor.js repair-state <campaign-key> [--data-dir <dir>] [--yes]",
    "",
    "Stop the recorder/dashboard before running remove or promote.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--data-dir") args.dataDir = argv[++i];
    else if (a === "--after") args.after = argv[++i];
    else if (a === "--hash") args.hash = argv[++i];
    else if (a === "--yes") args.yes = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else args._.push(a);
  }
  return args;
}

// snapshots.jsonl/war-events.jsonl get gzip-compacted by the recorder's own
// scan() as soon as a campaign isn't the one actively being played (see
// llama-log-machine.js's compactCampaignLedger) - exactly the "reloaded an
// old save" scenario this whole tool exists for. Reading only the plain path
// used to silently see an EMPTY campaign for any dormant one, which made
// `promote` overwrite real gzipped history with a single entry and made
// `repair-state` wipe a perfectly fine campaign's tracked baseline. Reuse the
// recorder's own plain-or-gzip reader so this tool sees exactly what every
// other consumer (dashboard, web app) sees.
function readJsonl(file) {
  return Recorder.readLedgerText(file)
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

// Writes the plain form and removes any stale .gz twin so the campaign never
// ends up with both forms on disk at once (every reader prefers plain, so a
// leftover .gz wouldn't be wrong, but it would misrepresent what this tool
// actually changed and violate the "never both at once" invariant the rest
// of the recorder relies on).
function writeJsonl(file, rows) {
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
  const gzFile = file + ".gz";
  if (fs.existsSync(gzFile)) fs.unlinkSync(gzFile);
}

function latestSnapshot(snapshots) {
  let latest = null;
  for (const snapshot of snapshots) {
    if (!snapshot || Recorder.dateKey(snapshot.date) === null) continue;
    if (!latest || Recorder.compareDates(snapshot.date, latest.date) > 0) latest = snapshot;
  }
  return latest;
}

// Roll recorder state back to the newest snapshot that survived a removal.
// Keep state.files/state.hashes intact: they are the recorder's "already seen"
// cache, and forgetting a discarded save there would let the same file/hash be
// imported again as soon as the dashboard restarts.
function rewindStateAfterRemoval(state, campaignKey, keptSnapshots, removedHashes) {
  state.lastDateByCampaign = state.lastDateByCampaign || {};
  state.activeWarsByCampaign = state.activeWarsByCampaign || {};
  state.checkpoints = state.checkpoints || {};

  const latest = latestSnapshot(keptSnapshots);
  if (latest) {
    const { currentWars } = Recorder.classifyEvents({}, latest);
    state.lastDateByCampaign[campaignKey] = latest.date;
    state.activeWarsByCampaign[campaignKey] = currentWars;
    if (!state.lastSnapshot || state.lastSnapshot.campaignKey === campaignKey) {
      state.lastSnapshot = {
        hash: latest.sourceHash,
        date: latest.date,
        file: path.basename(latest.sourceFile || ""),
        campaignKey,
        warCount: (latest.wars || []).length,
      };
    }
  } else {
    delete state.lastDateByCampaign[campaignKey];
    delete state.activeWarsByCampaign[campaignKey];
    if (state.lastSnapshot && state.lastSnapshot.campaignKey === campaignKey) state.lastSnapshot = null;
  }

  for (const [checkpoint, hash] of Object.entries(state.checkpoints)) {
    if (removedHashes.has(hash)) delete state.checkpoints[checkpoint];
  }

  return latest;
}

function campaignPaths(dataDir, campaignKey) {
  const dir = Recorder.campaignDir({ campaignsDir: path.join(dataDir, "campaigns") }, campaignKey);
  if (!fs.existsSync(dir)) throw new Error(`No campaign folder found at ${dir}`);
  return {
    dataDir,
    dir,
    stateFile: path.join(dataDir, "state.json"),
    snapshots: Recorder.campaignSnapshotsFile({ campaignsDir: path.join(dataDir, "campaigns") }, campaignKey),
    events: Recorder.campaignEventsFile({ campaignsDir: path.join(dataDir, "campaigns") }, campaignKey),
    anomalies: Recorder.campaignAnomaliesFile({ campaignsDir: path.join(dataDir, "campaigns") }, campaignKey),
  };
}

// Backs up every file this tool might touch, unconditionally, before any
// real (--yes) change - beside campaigns/ in the data root, never inside it
// (so it's never mistaken for part of the live ledger by the recorder or
// any other consumer).
function backup(paths) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(paths.dataDir, `_backup_${path.basename(paths.dir)}_${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });
  for (const file of [paths.snapshots, paths.events, paths.anomalies, paths.stateFile]) {
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(backupDir, path.basename(file)));
    // snapshots.jsonl/war-events.jsonl may currently exist only as a
    // gzip-compacted ".gz" twin (see readJsonl's comment) - back that up too,
    // or a dormant campaign's real history never actually gets backed up.
    const gzFile = file + ".gz";
    if (fs.existsSync(gzFile)) fs.copyFileSync(gzFile, path.join(backupDir, path.basename(gzFile)));
  }
  return backupDir;
}

function cmdList(campaignKey, args) {
  const dataDir = path.resolve(args.dataDir || DEFAULT_DATA_DIR);
  const paths = campaignPaths(dataDir, campaignKey);
  const snapshots = readJsonl(paths.snapshots);
  console.log(`${snapshots.length} snapshot(s) in ${paths.snapshots}\n`);
  let previousYear = null;
  snapshots.forEach((snap, i) => {
    const year = parseInt(String(snap.date || "").split(".")[0], 10);
    const gap = previousYear !== null && Number.isFinite(year) ? year - previousYear : null;
    const flag = gap !== null && gap > 5 ? `  <-- ${gap} year jump from the previous line` : "";
    console.log(`${String(i + 1).padStart(4)}  ${(snap.date || "?").padEnd(14)} ${(snap.sourceHash || "").slice(0, 12)}  ${snap.sourceFile || ""}${flag}`);
    if (Number.isFinite(year)) previousYear = year;
  });

  const anomalies = readJsonl(paths.anomalies);
  console.log(`\n${anomalies.length} quarantined anomaly/anomalies in ${paths.anomalies}`);
  for (const a of anomalies) {
    console.log(`  ${(a.date || "?").padEnd(14)} ${(a.sourceHash || "").slice(0, 12)}  ${a.anomalyReason || ""}`);
  }
}

function cmdRemove(campaignKey, args) {
  if (!args.after && !args.hash) {
    console.error("remove needs --after <date> or --hash <sourceHashPrefix>\n\n" + usage());
    process.exit(1);
  }
  const dataDir = path.resolve(args.dataDir || DEFAULT_DATA_DIR);
  const paths = campaignPaths(dataDir, campaignKey);
  const snapshots = readJsonl(paths.snapshots);
  const events = readJsonl(paths.events);

  const afterKey = args.after ? Recorder.dateKey(args.after) : null;
  if (args.after && afterKey === null) throw new Error(`Could not parse --after date: ${args.after}`);

  const matches = (snap) => {
    if (args.hash) return (snap.sourceHash || "").startsWith(args.hash);
    const key = Recorder.dateKey(snap.date);
    return key !== null && key > afterKey;
  };

  const removedSnapshots = snapshots.filter(matches);
  if (!removedSnapshots.length) {
    console.log("Nothing matched - no changes made.");
    return;
  }
  const removedHashes = new Set(removedSnapshots.map((s) => s.sourceHash));
  const keptSnapshots = snapshots.filter((s) => !removedHashes.has(s.sourceHash));
  const removedEvents = events.filter((e) => removedHashes.has(e.sourceHash));
  const keptEvents = events.filter((e) => !removedHashes.has(e.sourceHash));
  const rollbackSnapshot = latestSnapshot(keptSnapshots);

  console.log(`Would remove ${removedSnapshots.length} snapshot(s) and ${removedEvents.length} derived event(s):`);
  for (const s of removedSnapshots) console.log(`  snapshot  ${s.date}  ${(s.sourceHash || "").slice(0, 12)}  ${s.sourceFile || ""}`);
  for (const e of removedEvents) console.log(`  event     ${e.date}  ${e.type}`);
  console.log(
    rollbackSnapshot
      ? `  state.json -> rewind ${campaignKey} to ${rollbackSnapshot.date} and ${(rollbackSnapshot.wars || []).length} active war(s)`
      : `  state.json -> remove ${campaignKey}'s tracked date and active-war baseline (no snapshots remain)`
  );

  if (!args.yes) {
    console.log(`\nsnapshots.jsonl would go ${snapshots.length} -> ${keptSnapshots.length}, war-events.jsonl ${events.length} -> ${keptEvents.length}.`);
    console.log("This was a dry run - re-run with --yes to actually apply it. No files were changed.");
    return;
  }

  const backupDir = backup(paths);
  console.log(`\nBacked up to ${backupDir}`);
  writeJsonl(paths.snapshots, keptSnapshots);
  writeJsonl(paths.events, keptEvents);
  const state = Recorder.loadJson(paths.stateFile, {});
  const rewoundTo = rewindStateAfterRemoval(state, campaignKey, keptSnapshots, removedHashes);
  Recorder.saveJson(paths.stateFile, state);
  console.log(`snapshots.jsonl: ${snapshots.length} -> ${keptSnapshots.length}`);
  console.log(`war-events.jsonl: ${events.length} -> ${keptEvents.length}`);
  console.log(
    rewoundTo
      ? `state.json: ${campaignKey} now resumes from ${rewoundTo.date} with ${(rewoundTo.wars || []).length} active war(s)`
      : `state.json: cleared ${campaignKey}'s tracked date and active-war baseline`
  );
  console.log(
    "\nIf this campaign was ever shared via the web app's Share link, its Supabase copy is now stale " +
      "(delete the matching rows there too, or just click Share link again once the recorder is back up to date)."
  );
}

function cmdPromote(campaignKey, args) {
  if (!args.hash) {
    console.error("promote needs --hash <sourceHashPrefix>\n\n" + usage());
    process.exit(1);
  }
  const dataDir = path.resolve(args.dataDir || DEFAULT_DATA_DIR);
  const paths = campaignPaths(dataDir, campaignKey);
  const anomalies = readJsonl(paths.anomalies);
  const target = anomalies.find((a) => (a.sourceHash || "").startsWith(args.hash));
  if (!target) {
    console.log(`No quarantined anomaly matching hash prefix "${args.hash}" in ${paths.anomalies}`);
    return;
  }

  const promoted = Object.assign({}, target);
  delete promoted.anomalyReason;

  // Re-baseline war tracking on the promoted snapshot's OWN war list (via
  // classifyEvents with an empty previousWars, which just reshapes
  // snapshot.wars into the currentWars format state.activeWarsByCampaign
  // expects - its `events` output is deliberately discarded, since every
  // one of those "events" would just be this snapshot's already-ongoing
  // wars looking like they "started here", which is exactly the kind of
  // bogus event this whole guard exists to avoid). This means a promoted
  // jump is never retroactively explained - nothing from the skipped years
  // is recoverable - but every war-event from THIS point forward will be
  // correctly diffed against real history again.
  const { currentWars } = Recorder.classifyEvents({}, promoted);

  console.log(`Would promote snapshot ${promoted.date} (${(promoted.sourceHash || "").slice(0, 12)}) into the real ledger:`);
  console.log(`  - append it to snapshots.jsonl (no war-start/disappeared events - the skipped years stay unexplained)`);
  console.log(`  - remove it from anomalies.jsonl`);
  console.log(`  - reset this campaign's tracked war state to the ${Object.keys(currentWars).length} war(s) visible in this snapshot`);
  console.log(`  - move state.json's last-tracked date for this campaign forward to ${promoted.date}`);

  if (!args.yes) {
    console.log("\nThis was a dry run - re-run with --yes to actually apply it. No files were changed.");
    return;
  }

  const backupDir = backup(paths);
  console.log(`\nBacked up to ${backupDir}`);

  const snapshots = readJsonl(paths.snapshots);
  snapshots.push(promoted);
  writeJsonl(paths.snapshots, snapshots);
  writeJsonl(paths.anomalies, anomalies.filter((a) => a !== target));

  const state = Recorder.loadJson(paths.stateFile, {});
  state.lastDateByCampaign = state.lastDateByCampaign || {};
  state.activeWarsByCampaign = state.activeWarsByCampaign || {};
  state.lastDateByCampaign[campaignKey] = promoted.date;
  state.activeWarsByCampaign[campaignKey] = currentWars;
  Recorder.saveJson(paths.stateFile, state);

  console.log(`Promoted. snapshots.jsonl now has ${snapshots.length} entries; recorder will treat ${promoted.date} as this campaign's baseline going forward.`);
}

function cmdRepairState(campaignKey, args) {
  const dataDir = path.resolve(args.dataDir || DEFAULT_DATA_DIR);
  const paths = campaignPaths(dataDir, campaignKey);
  const snapshots = readJsonl(paths.snapshots);
  const latest = latestSnapshot(snapshots);
  const state = Recorder.loadJson(paths.stateFile, {});
  const oldDate = state.lastDateByCampaign && state.lastDateByCampaign[campaignKey];
  const oldWarCount = Object.keys((state.activeWarsByCampaign && state.activeWarsByCampaign[campaignKey]) || {}).length;

  console.log(
    latest
      ? `Would repair state.json for ${campaignKey}: ${oldDate || "untracked"}/${oldWarCount} active war(s) -> ${latest.date}/${(latest.wars || []).length} active war(s)`
      : `Would clear state.json's tracked date and active-war baseline for ${campaignKey} because its ledger has no snapshots`
  );

  if (!args.yes) {
    console.log("\nThis was a dry run - re-run with --yes to actually apply it. No files were changed.");
    return;
  }

  const backupDir = backup(paths);
  console.log(`\nBacked up to ${backupDir}`);
  const repairedTo = rewindStateAfterRemoval(state, campaignKey, snapshots, new Set());
  Recorder.saveJson(paths.stateFile, state);
  console.log(
    repairedTo
      ? `Repaired. The recorder will resume ${campaignKey} from ${repairedTo.date} with ${(repairedTo.wars || []).length} active war(s).`
      : `Repaired. ${campaignKey} no longer has a stale recorder baseline.`
  );
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const [command, campaignKey] = args._;
  if (!command || !campaignKey) {
    console.error(usage());
    process.exit(1);
  }
  if (command === "list") return cmdList(campaignKey, args);
  if (command === "remove") return cmdRemove(campaignKey, args);
  if (command === "promote") return cmdPromote(campaignKey, args);
  if (command === "repair-state") return cmdRepairState(campaignKey, args);
  console.error(`Unknown command: ${command}\n\n${usage()}`);
  process.exit(1);
}

try {
  main();
} catch (err) {
  console.error(err.message || String(err));
  process.exit(1);
}
