# Supabase and Netlify Release Prep

This repo is now initialized for the same broad flow as MSV2: Supabase holds the shared campaign ledger data, and Netlify will eventually host the static browser app. Nothing here deploys Netlify yet.

## Supabase Project

Project URL:

```text
https://wkylbxozlppqovlwjxsy.supabase.co
```

Project ref:

```text
wkylbxozlppqovlwjxsy
```

Dashboard:

```text
https://supabase.com/dashboard/project/wkylbxozlppqovlwjxsy
```

Public anon and service role keys are stored locally in ignored `.env.local`. Do not commit or paste the service role key into frontend JavaScript, Netlify, GitHub, or chat.

## Current Cost Guardrails

Supabase's pricing page currently lists a Free plan at `$0/month` with `500 MB database size`, `5 GB egress`, and `2 active projects`; free projects pause after one week of inactivity:

```text
https://supabase.com/pricing
```

The current local recorder ledger corpus is about 26 MB on disk before Postgres/JSONB overhead, so it should fit comfortably for early testing. Avoid importing full save archives or the ignored `archive/` folders.

## What Was Added

- `supabase/config.toml`: created by `supabase.cmd init`.
- `supabase/migrations/20260711020000_eu5_llama_ledgers.sql`: public-read tables and a campaign-ledger RPC.
- `scripts/import-llama-ledgers-to-supabase.js`: local JSONL importer using the Supabase REST API and a service role key.
- `netlify.toml`: static hosting config only; no site has been linked or deployed.
- `scripts/build-netlify-site.js`: stages only the public browser app into `dist/`.
- `.netlifyignore`: keeps personal saves, recorder data, backups, temp files, and secrets out of manual Netlify deploys.

## Schema Shape

- `eu5_campaigns`: one summary row per recorder campaign.
- `eu5_campaign_snapshots`: raw snapshot JSONB rows keyed by `campaign_key + source_hash`.
- `eu5_war_events`: raw event JSONB rows keyed by a deterministic `event_id`.
- `eu5_latest_campaigns`: lightweight public listing view.
- `eu5_get_campaign_ledger(campaign_key)`: returns one JSON object containing campaign metadata, snapshots, and events in scoring order.

RLS is enabled. Browser/anon users can read. The import path should use the service role key locally, never in frontend code.

## CLI Workflow

PowerShell blocks the `supabase.ps1` shim on this machine, so use `supabase.cmd`:

```powershell
supabase.cmd --version
supabase.cmd login
supabase.cmd link --project-ref wkylbxozlppqovlwjxsy
supabase.cmd db push --dry-run
supabase.cmd db push
```

If you apply SQL manually in Supabase Studio instead of `db push`, check migration bookkeeping before a later CLI push:

```powershell
supabase.cmd migration list --linked
```

## Import Workflow

First copy `.env.example` to `.env.local` and fill in:

```text
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
```

The local `.env.local` has already been created for the current Supabase project.

Do a local parse/count first:

```powershell
node scripts/import-llama-ledgers-to-supabase.js --dry-run
```

Import everything:

```powershell
$env:SUPABASE_URL = "https://YOUR_PROJECT_REF.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "YOUR_SERVICE_ROLE_KEY"
node scripts/import-llama-ledgers-to-supabase.js
```

Or one campaign:

```powershell
node scripts/import-llama-ledgers-to-supabase.js --campaign 3baa76aa-825a-4655-ae49-02edd3b90a4b
```

## Netlify Later

The repo root now has a `netlify.toml` that builds the static app into `dist/` and adds conservative headers. Do not run a Netlify deploy yet if you want to preserve free monthly build/deploy quota.

When it is time:

```powershell
npm run build
netlify deploy --dir dist
```

For Git-based deploys, connect the repo in Netlify and let it read `netlify.toml`. Set only public browser variables there, such as the Supabase URL and anon/publishable key once the frontend reads from Supabase. Never set or expose the service role key in Netlify frontend code.
