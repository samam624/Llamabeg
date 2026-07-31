---
name: rebuild-llama-dashboard
description: Rebuild the local llama-dashboard test build (`llama-dashboard/release/Llama Score Dashboard-win32-x64/`) after changing main.js/preload.js/renderer/js source, and verify real campaign data survived. Use whenever a task changes anything under llama-dashboard/, js/, tools/scan-modifier-sources.js, or llama-score-automatic-logging-machine/, and the user wants to test it locally (not the real Documents install - see below).
---

# Rebuilding the local llama-dashboard test build

This project has **two separate installs of the same app** - don't confuse
them:

1. **`llama-dashboard/release/Llama Score Dashboard-win32-x64/`** - a build
   artifact inside the repo, gitignored, produced by `npm run dist`. As of
   2026-07, the user has designated THIS as their local test target
   ("keep updating the local release file in this dir first, we'll migrate
   over from the website later"). It has its own real recorded campaign data
   in a sibling `data/` folder (2+ real campaigns as of 2026-07-19 - treat
   that data as real, not disposable).
2. **`%USERPROFILE%\Documents\Llama-Score-Dashboard-win32-x64`** - the
   user's actual day-to-day live install, entirely separate, does NOT
   auto-update from either the repo or build #1. Only touch this if
   explicitly asked to deploy there - it's a bigger, separate step (build,
   then copy over with the real ledger excluded/preserved, same as any other
   deploy to a live install).

**Never assume file timestamps tell you which commit a build is from** - a
build's own file mtimes reflect when it was extracted/packaged, not what
source it contains. Always diff actual file content (or grep for a marker
string/recently-added identifier) against current source before claiming a
build already has a fix.

## Steps

1. **Check for a running instance first** - `npm run dist` fails with
   `EBUSY: resource busy or locked` if `Llama Score Dashboard.exe` is
   currently open (it locks its own directory). Check:
   ```powershell
   Get-Process "Llama Score Dashboard" -ErrorAction SilentlyContinue
   ```
   If something is running, **ask before closing it** - it may be the user's
   own active window (they might be mid-testing a previous fix). Don't just
   kill it silently.

2. **Rebuild**:
   ```bash
   cd llama-dashboard && npm run dist
   ```
   This runs `scripts/prepare-vendor.js` (copies `js/*`/`tools/scan-modifier-
   sources.js`/recorder files into `vendor/`) then `scripts/package-
   dashboard.js` (electron-packager, with `--overwrite`). That second script
   **already backs up and restores `release/.../data/` around the packaging
   step** - you do not need to manually copy the ledger out of the way
   first; that safety net is already built in and confirmed working.

3. **Verify real data survived** (cheap, always do this):
   ```bash
   node -e "console.log(JSON.parse(require('fs').readFileSync('llama-dashboard/release/Llama Score Dashboard-win32-x64/data/state.json','utf8')).lastDateByCampaign)"
   ```
   Compare campaign keys/dates against what was there before the rebuild.

4. **Verify the fix is actually in the build** (don't trust the rebuild
   succeeding as proof) - diff the packaged copy against source:
   ```bash
   diff -q llama-dashboard/renderer/renderer.js "llama-dashboard/release/Llama Score Dashboard-win32-x64/resources/app/renderer/renderer.js"
   ```
   (or grep for a string unique to the change). No output from `diff -q`
   means identical.

## Gotchas

- **`ELECTRON_RUN_AS_NODE=1` may already be set in this shell's
  environment.** If so, `electron.exe`/`npm start` silently runs as plain
  Node instead of launching a real Electron window - `require("electron")`
  returns `undefined` for `app`/`BrowserWindow`, crashing with "Cannot read
  properties of undefined (reading 'requestSingleInstanceLock')". This only
  matters for *launching* the app (see the `drive-llama-dashboard` skill),
  not for `npm run dist` itself (electron-packager doesn't launch Electron).
- `release/` is gitignored - don't expect `git status` to show any of this.
- The build wrapper creates an empty `data/` folder on a genuinely first
  build (no prior data to restore) - that's expected, not a bug.
