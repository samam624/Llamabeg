# 🪓 Llama Score Logging Machine

Small companion recorder for EU5 campaigns. It watches a save folder, waits for
new/changed autosaves to finish writing, parses only the light campaign metadata
needed for war logging, and appends compact JSONL records.

It does not modify the game, saves, or mods. It reads copied save files only.

Most players should use the **Llama Score Dashboard** instead (see
[llama-dashboard/README.md](../llama-dashboard/README.md)) - it's this same recorder
wrapped in a desktop app (Windows/macOS/Linux) with a GUI, no command line needed. This
script is for headless/server setups, or anyone who'd rather run it directly.

## Run

```powershell
node .\llama-score-automatic-logging-machine\llama-log-machine.js --save-dir "C:\Users\<you>\Documents\Paradox Interactive\Europa Universalis V\save games"
```

By default, output is written to:

```text
llama-score-automatic-logging-machine/data/
```

Each campaign gets its own bin, keyed by the autosave UUID:

```text
data/campaigns/<campaignUUID>/snapshots.jsonl   - one compact parsed snapshot per processed autosave
data/campaigns/<campaignUUID>/war-events.jsonl  - detected war start/update/disappear events
data/campaigns/<campaignUUID>/archive/          - full save copies for interesting snapshots only
data/state.json                                 - recorder state, file hashes, active-war cache (shared across campaigns)
```

Point the analyzer's Llama Score panel at one campaign's `snapshots.jsonl` +
`war-events.jsonl` to score just that campaign. Older versions of this
recorder wrote one shared `data/snapshots.jsonl` / `data/war-events.jsonl`
across every campaign ever recorded - mixing campaigns corrupts player/
country attribution and the "latest state" the analyzer scores from, since
country numbers and "most recent snapshot" are only meaningful within a
single campaign. The recorder auto-migrates a legacy ledger like this into
per-campaign bins the next time it starts, moving the originals to
`data/legacy/`.

By default it only watches the most recent autosave campaign UUID in the save
folder. That keeps startup cheap and avoids mixing old campaigns into the
current run. Use `--all-campaigns` for backfills, or `--campaign <uuid>` to pin
one specific campaign.

By default it also keeps only wars involving a human-played country. Set
`"playerWarsOnly": false` in config for a full-world diagnostic backfill.
Country economy/territory snapshots are likewise limited to player-war
participants unless `"storeAllEconomyCountries": true` is enabled.

## Retention Model

The recorder does not blindly keep every full autosave forever. It always keeps
the small parsed ledger, but only archives full saves when something useful
happens:

- a war appears,
- a war changes meaningfully,
- a war disappears from the save,
- a periodic checkpoint is due.

This keeps the core recorder low-cost while preserving enough evidence to debug
the hard cases.

`war-events.jsonl` includes each war's participants split by side, last known
attacker/defender score when the save still exposes it, and an `outcome` or
`inferredOutcome` block. If EU5 purges a war before a concluded snapshot is
captured, the winner is marked as inferred rather than authoritative.

## Notes

EU5 autosaves appear to rotate as:

```text
autosave_<campaign>.eu5
autosave_<campaign>_1.eu5
...
autosave_<campaign>_5.eu5
```

The unsuffixed file is newest, `_5` is oldest. The recorder copies interesting
saves before the game rotates them away.
