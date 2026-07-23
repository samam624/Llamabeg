# Llama Score Dashboard

A desktop window version of the Llama Score recorder
(`../llama-score-automatic-logging-machine`). Launch it once and it:

- watches your EU5 save folder for new autosaves (same detection logic as the
  CLI recorder - embedded directly, not a separate process you have to run),
- scores concluded wars and infers ongoing ones the moment a new autosave
  lands,
- shows a live view: ongoing player wars, concluded wars with the score
  exchanged on each side, and the Llama Points leaderboard.
- includes an early **Modifier Optimizer** tab that cross-references the
  latest player-country advances/laws/reforms/privileges with modifier grants
  in the local EU5 install, separates actions proven eligible now from blocked
  and not-yet-supported requirements, and provides a Societal Values picker
  with current position/impact, monthly contributors, directional ceiling,
  and exact category -> law group -> choice navigation paths. Societal-value
  estate-privilege recommendations use their localized in-game names, are
  grouped by owning estate, and rank the lowest estate-power cost first. The
  active-estate list comes from each estate manager entry's real
  `existence=true` state; privileges for inactive estates are blocked rather
  than presented as available.
  The equilibrium includes live average-development, average-control, and subject
  relationship pressure as well as active player choices in both directions.
  When new compact modifier facts are added, the recorder refreshes them once
  from the newest autosave even if that autosave itself has not changed.

It reads/writes the **same ledger** the web app's "Connect campaign
folder..." button already points at - a `data` folder it creates right next
to the .exe in a packaged build (`../llama-score-automatic-logging-machine/data`
in dev, via `npm start`) - so anything this app records is immediately
visible to the web app too, and vice versa.

**Don't run `node llama-log-machine.js` (the standalone CLI recorder) at the
same time as this app against the same data folder** - both would append to
the same `snapshots.jsonl`/`war-events.jsonl`/`state.json` concurrently,
which can interleave writes and corrupt the ledger. Use one or the other.

## Run in development

```powershell
cd llama-dashboard
npm install
npm start
```

First run downloads Electron itself (~150 MB). After that, `npm start` opens
the window directly against the real save folder/data folder - no build step
needed while iterating on the UI.

## Build a standalone app you can launch from the Desktop

```powershell
cd llama-dashboard
npm run dist
```

This vendors a copy of `js/llama-score.js` + the recorder into
`llama-dashboard/vendor/` (so the packaged app doesn't depend on the rest of
this repo at runtime) and packages everything with `electron-packager` into:

```text
llama-dashboard/release/Llama Score Dashboard-win32-x64/
  Llama Score Dashboard.exe   <- the app
  ...(Electron runtime files - all required, don't separate them from the exe)
```

This is a portable Electron app, not a single-file exe - all the files in
that folder need to stay together. To launch it like a normal app:

1. Right-click `Llama Score Dashboard.exe` -> **Send to -> Desktop (create
   shortcut)**.
2. Launch it from that Desktop shortcut whenever you want the dashboard - no
   terminal needed.

Re-run `npm run dist` after changing `main.js`/`preload.js`/`renderer/` or
after `js/llama-score.js`/the recorder itself changes upstream - the vendored
copy is a snapshot, not a live link.

`release/Llama Score Dashboard-win32-x64/` is the single canonical local
build. Re-run `npm run dist` to update that folder in place; do not create
separate version-named test-build folders. Close any older copy of the app
before launching the canonical executable, because the single-instance lock
will otherwise focus the already-running older build.

The build wrapper preserves and restores the canonical folder's existing
`data/` ledger while Electron replaces the app runtime. It creates an empty
`data/` folder for a first build.

## Cutting a distributable .zip (for other people to download)

```powershell
cd llama-dashboard
npm run release
```

This runs `dist` and then zips the packaged output into
`llama-dashboard/release/Llama-Score-Dashboard-win32-x64.zip` - the exact file
the website's download link points at (see the root `index.html`'s hardcoded
GitHub Releases URL). Upload that file as the release asset.

The ZIP is staged separately and always contains an empty `data/` folder.
Local `state.json`, campaign snapshots, war events, and other recorder data
are explicitly excluded even if the canonical local app contains them.

**Always use `npm run release` for this - never rename/zip the
`release/Llama Score Dashboard-win32-x64/` folder by hand.** A previous
release was built by hand (build, rename the folder to remove the spaces,
right-click -> zip, upload) and the manual rename step left a trailing space
in the folder's name without anyone noticing. Every person who downloaded
and unzipped that release got a folder Windows Explorer could see but could
never delete or rename ("Item Not Found... this is no longer located in..."),
because Win32's normal path-handling APIs (the ones Explorer's own delete
uses) silently strip a trailing space before doing the actual filesystem
lookup, while NTFS preserves the literal name - so the folder is real, but
almost nothing can address it correctly by name. (The only fix, if this
happens to you: prefix the path with `\\?\` to bypass that normalization,
e.g. `Remove-Item -LiteralPath "\\?\C:\full\path\to\the folder "` in
PowerShell - note the exact trailing character(s) must still match; use
`Get-ChildItem`'s `.FullName` rather than retyping the name by hand.)
`scripts/package-release-zip.js` sets the zip's internal folder name
programmatically (via `archiver`, not a filesystem rename) specifically so
there's no rename step left for a stray keystroke to hide in, and it
self-checks that name for a trailing space/dot before writing anything.

## Settings

The **Settings** button in the app lets you point it at a different save
folder or data folder (persisted to this app's own user-data folder, not
this repo). Defaults, no configuration needed for a typical single-PC
install:

- **EU5 save folder** - `Documents\Paradox Interactive\Europa Universalis V\save games`
- **EU5 install folder** - used only by Modifier Optimizer to read game
  definitions; defaults to the standard Steam install path.
  under the current Windows user, same default the CLI recorder uses.
- **Ledger data folder** - a `data` folder created next to
  `Llama Score Dashboard.exe` (in a packaged build) - the same folder the web
  app's "Connect campaign folder..." should be pointed at.

Changing either restarts the embedded watcher.

## Architecture notes

- `main.js` embeds `llama-score-automatic-logging-machine/llama-log-machine.js`'s
  `scan()` loop directly (via `require`, exported for exactly this purpose) -
  same save-watching/parsing/ledger-writing code the CLI uses, not a
  reimplementation, and not a spawned child process.
- Reads the resulting `snapshots.jsonl`/`war-events.jsonl` and scores them
  with `js/llama-score.js`'s `computeFromLedger`/`summarizeWars` - the exact
  same scoring engine the web app's Llama Score tab uses.
- "Ongoing wars" come straight from the latest snapshot's own war list
  (`concluded: false` entries) - concluded/scored wars come from
  `war-events.jsonl`'s `war-disappeared` events, same as the web app.
- Packaging uses `electron-packager`, not `electron-builder` - this repo's
  sandboxed build environment couldn't extract electron-builder's
  `winCodeSign` dependency (needs a Windows symlink privilege electron-builder
  requests even when not code-signing), and enabling that machine-wide
  (Developer Mode) wasn't something to change without asking. `electron-packager`
  needs no code-signing tooling at all, at the cost of producing a
  folder+exe instead of a single compressed installer.
