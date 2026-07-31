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

## Build the Windows desktop distributions

```powershell
cd llama-dashboard
npm run make-installer
npm run release
npm run verify-update-release
```

`make-installer` produces the normal, no-admin Squirrel installation and its
update metadata:

```text
llama-dashboard/out/make/squirrel.windows/x64/
  Llama-Score-Dashboard-Setup.exe
  LlamaScoreDashboard-<version>-full.nupkg
  RELEASES
```

`release` keeps the legacy portable fallback current at the two canonical
paths:

```text
llama-dashboard/release/Llama Score Dashboard-win32-x64/
llama-dashboard/release/Llama-Score-Dashboard-win32-x64.zip
```

The release verifier checks Squirrel's manifest hash/size, version and tag,
the exact canonical release names, packaged runtime hashes, signatures when
required, and that both public archives contain zero campaign-data files.
The canonical app's local `data/` ledger is held outside the replacement
path during a rebuild and restored afterward.

Installed and portable apps use
`Documents\Llamabeg\Campaign Data`. On first packaged launch, data from the
old extracted `Documents\Llama-Score-Dashboard-win32-x64\data` location is
copied through a hash-verified staging directory; the original is retained
as a backup.

## Automatic updates and GitHub releases

Only the Squirrel-installed app enables automatic updates. It confirms that
the installation's parent `Update.exe` exists, checks once at startup and
then hourly, downloads in the background, and asks before restarting.
Development and portable builds deliberately do not update themselves.

Setup.exe uses Squirrel's silent per-user installation flow. It shows no
wizard: running it installs under `%LOCALAPPDATA%\LlamaScoreDashboard` and
immediately launches the installed version. Subsequent launches should use
the **Llamabeg → Llama Score Dashboard** Start-menu shortcut. Runtime
settings/logs live under `%APPDATA%\llama-score-dashboard`, while campaign
history remains under `%USERPROFILE%\Documents\Llamabeg\Campaign Data`.

Public downloads and Electron's update service use this repository's GitHub
Releases:

```text
https://github.com/samam624/Llamabeg/releases
```

The repository must remain public so installed clients can check releases
without credentials. The workflow uploads only Setup.exe, the `.nupkg`,
`RELEASES`, and the empty-data portable ZIP; settings, saves, and ledger data
remain outside the repository and packaged artifacts.

Optionally configure these repository secrets:

- `WINDOWS_CERTIFICATE_PFX_BASE64`: base64 contents of the trusted Windows
  code-signing `.pfx`.
- `WINDOWS_CERTIFICATE_PASSWORD`: password for that certificate.

The workflow's built-in `GITHUB_TOKEN` publishes the release to this
repository; no personal access token or second release repository is needed.
`.github/workflows/desktop-release.yml` supports unsigned manual CI builds,
and publishes a verified unsigned tagged release when no certificate is
configured. If both secrets are present, it signs the application and
installer and requires valid Authenticode signatures before publishing.
Unsigned installers trigger Windows's unknown-publisher warning on first
installation.

### Does every push update installed apps?

No. Pushing a commit or merging a branch only updates the source repository.
Installed clients change only when all of these conditions are satisfied:

1. `llama-dashboard/package.json` and `package-lock.json` contain the same
   newer SemVer version.
2. That source and `.github/workflows/desktop-release.yml` are committed and
   pushed to the public repository.
3. A matching tag such as `v1.0.2` is pushed.
4. The tagged Windows workflow succeeds, including Authenticode verification
   when signing credentials are configured.
5. The resulting GitHub Release contains Setup.exe, the versioned full
   `.nupkg`, `RELEASES`, and the empty-data portable ZIP.

If any condition fails, no update is published and existing installations
continue running their current version. Users who are offline or have the app
closed receive the update the next time an installed copy can perform a
check. Portable and development builds are never eligible.

### Maintainer release checklist

To publish an update:

1. Update `llama-dashboard/package.json` and `package-lock.json` to the same
   SemVer version, which must be greater than the last published version.
2. Run `npm.cmd test` from `llama-dashboard/`.
3. Commit and push all intended application and workflow changes.
4. Create and push the matching tag:

   ```powershell
   git tag v1.0.2
   git push origin v1.0.2
   ```

5. The Windows workflow builds, verifies, signs, and publishes the four
   assets to this repository's GitHub Release.
6. Confirm the release is marked latest and contains all four expected
   assets before announcing it.

The website download button uses this repository's
`releases/latest/download/Llama-Score-Dashboard-Setup.exe` URL.

## Settings

The **Settings** button in the app lets you point it at a different save
folder or data folder (persisted to this app's own user-data folder, not
this repo). Defaults, no configuration needed for a typical single-PC
install:

- **EU5 save folder** - `Documents\Paradox Interactive\Europa Universalis V\save games`
- **EU5 install folder** - used only by Modifier Optimizer to read game
  definitions; defaults to the standard Steam install path.
  under the current Windows user, same default the CLI recorder uses.
- **Ledger data folder** - `Documents\Llamabeg\Campaign Data`, independent
  of the installed application version - the same folder the web app's
  "Connect campaign folder..." should be pointed at.

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
- The portable fallback uses Electron Packager; the normal installer and
  update package use Electron Forge's Squirrel.Windows maker. Both use the
  same vendored recorder/parser runtime and optional signing certificate.
