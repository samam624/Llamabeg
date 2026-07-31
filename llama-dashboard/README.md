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

## Build desktop distributions

Electron Forge must build each native installer on its matching operating
system. The tagged GitHub Actions workflow is the canonical way to produce
the complete release:

- Windows x64: Squirrel `Setup.exe`, `.nupkg`, `RELEASES`, and portable ZIP.
- macOS Intel and Apple Silicon: DMG installers and portable ZIPs.
- Linux x64 and ARM64: `.deb`, `.rpm`, and portable ZIPs.

Windows maintainers can still rebuild and verify the canonical Windows
artifacts locally:

```powershell
cd llama-dashboard
npm run make-installer
npm run release
npm run verify-update-release
npm run stage-platform-release -- --platform win32 --arch x64
```

On macOS or Linux, install the locked dependencies and run Forge for the
current machine's platform and architecture:

```bash
cd llama-dashboard
npm ci
npm run make-platform -- --platform=darwin --arch=arm64
# or: npm run make-platform -- --platform=linux --arch=x64
npm run stage-platform-release -- --platform darwin --arch arm64
```

The Windows verifier checks Squirrel's manifest hash/size, version and tag,
canonical release names, packaged runtime hashes, optional Authenticode
signatures, and zero campaign data. The platform staging verifier performs
the equivalent package-version, production-dependency, runtime-hash, and
zero-campaign-data checks for every macOS and Linux architecture before any
artifact reaches the publish job. The final release includes
`SHA256SUMS.txt`.

All packaged apps use the operating system's Documents folder at
`Llamabeg/Campaign Data`. The Windows local release build preserves the
canonical app's sibling `data/` folder byte-for-byte, and packaged artifacts
always contain zero campaign-data files.

## Updates and GitHub releases

Squirrel-installed Windows builds confirm that the installation's parent
`Update.exe` exists, check at startup and hourly, download updates in the
background, and ask before restarting. macOS and Linux builds check the same
public GitHub release at startup and hourly, then offer to open the download
page when a newer version exists.

macOS and Linux deliberately use notification-based updates for now:
Electron has no built-in Linux auto-updater, and Squirrel.Mac requires the app
to be signed with a paid Apple Developer certificate. Portable and
development builds do not update themselves.

Setup.exe uses Squirrel's silent per-user installation flow. macOS users open
the architecture-matched DMG and drag the app to Applications. Linux users
install the architecture-matched `.deb` or `.rpm`. Settings/logs use each
platform's standard application-data folder; campaign history remains in
Documents independently of application updates and uninstallation.

Public downloads and update checks use:

```text
https://github.com/samam624/Llamabeg/releases
```

The repository must remain public so clients can check releases without
credentials. The workflow's built-in `GITHUB_TOKEN` publishes to this
repository; no personal token or second repository is needed.

Windows signing is optional through:

- `WINDOWS_CERTIFICATE_PFX_BASE64`: base64 contents of the trusted Windows
  code-signing `.pfx`.
- `WINDOWS_CERTIFICATE_PASSWORD`: password for that certificate.

Without those secrets, Windows artifacts are verified but unsigned. macOS
artifacts are also unsigned and unnotarized until Apple Developer signing is
configured, so first launch can require the documented operating-system
override.

### Does every push update installed apps?

No. A commit or merged branch only updates source. A release reaches users
only when all of these conditions are satisfied:

1. `llama-dashboard/package.json` and `package-lock.json` contain the same
   newer SemVer version.
2. The intended source and workflow are committed and pushed publicly.
3. A matching tag such as `v1.1.0` is pushed.
4. All five native build jobs pass: Windows x64, two macOS architectures, and
   two Linux architectures.
5. The publish job verifies the complete asset set, writes checksums, and
   creates the latest GitHub Release.

If any platform fails, nothing is published and existing users remain on the
current version.

### Maintainer release checklist

1. Bump `llama-dashboard/package.json` and `package-lock.json` to the same
   version.
2. Run `npm.cmd test` from `llama-dashboard/`.
3. On Windows, close the dashboard, hash the live campaign ledger, run
   `npm.cmd run release`, and confirm the ledger is unchanged.
4. Commit and push the intended application, documentation, and workflow.
5. Create and push the matching tag:

   ```powershell
   git tag v1.1.0
   git push origin v1.1.0
   ```

6. Wait for every platform job and the single publish job to pass.
7. Confirm the release is latest, contains the 14 platform artifacts plus
   `SHA256SUMS.txt`, and that anonymous download links resolve.

## Settings

The **Settings** button in the app lets you point it at a different save
folder or data folder (persisted to this app's own user-data folder, not
this repo). Defaults require no configuration for a typical Windows or Steam
Proton install:

- **EU5 save folder** - the normal Documents path on Windows/macOS; on Linux
  the app checks standard Steam, Flatpak Steam, and EU5 Proton-prefix paths.
- **EU5 install folder** - used only by Modifier Optimizer to read game
  definitions; detects the standard Windows, macOS Steam, and Linux Steam
  locations.
- **Ledger data folder** - `Documents/Llamabeg/Campaign Data`, independent
  of the installed application version - the same folder the web app's
  "Connect campaign folder..." should be pointed at.

EU5 is officially Windows-only, so macOS compatibility-layer and unusual
Proton installations may need both EU5 folders selected manually. Changing
any setting restarts the embedded watcher.

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
- Windows's portable fallback uses Electron Packager. Native installers use
  Electron Forge: Squirrel.Windows, DMG/ZIP on macOS, and DEB/RPM/ZIP on
  Linux. Every package uses the same vendored recorder/parser runtime.
