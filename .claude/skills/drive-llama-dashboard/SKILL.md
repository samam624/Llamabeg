---
name: drive-llama-dashboard
description: Launch and drive the llama-dashboard Electron app via Chrome DevTools Protocol to verify a change actually works, without screenshots or OS-level click automation. Use whenever a task changes llama-dashboard/ (or js/tools it embeds) and needs to be verified running, or when asked to test/check/verify the dashboard app.
---

Drives the real, running app through its own JS context (`window.llamaAPI`,
DOM, `Runtime.evaluate`) instead of screenshots or simulated mouse
clicks. Two hard-won reasons this project uses CDP instead of the more
obvious approaches:

- **OS-level click/screenshot automation is unreliable here** (see
  `llama_dashboard_desktop_app` memory, 2026-07-11 sessions) - raw
  `SetCursorPos`/`mouse_event` clicks silently failed to register, most
  likely a DPI-awareness mismatch between an unaware calling process and
  Electron's per-monitor-DPI-aware window.
- **A screenshot attempt captured unrelated content from the user's real
  screen on 2026-07-18** (not the app window) while chasing an
  `ELECTRON_RUN_AS_NODE` launch bug. Don't repeat that - use `driver.js`
  instead of a screen-capture tool for this app, full stop.

Node 22+'s native `WebSocket`/`fetch` are all this needs - no Playwright or
`playwright-core` dependency.

## Before anything: check nothing is already running

```powershell
Get-Process "Llama Score Dashboard" -ErrorAction SilentlyContinue
```

If something's running, **ask before closing it** - it may be the user's
own active window. `launch` below will otherwise just silently focus that
existing window (single-instance lock) without the `--remote-debugging-port`
flag you need, and `eval`/`listen` will fail to find a CDP target.

## Commands

All run from the repo root (paths inside `driver.js` are relative to the
repo, not to your cwd):

```bash
node .claude/skills/drive-llama-dashboard/driver.js launch [packaged|dev]
node .claude/skills/drive-llama-dashboard/driver.js eval "<js expression>"
node .claude/skills/drive-llama-dashboard/driver.js listen [ms]
node .claude/skills/drive-llama-dashboard/driver.js set-settings <saveDir> <dataDir>
node .claude/skills/drive-llama-dashboard/driver.js quit
```

- **`launch`** - defaults to `packaged` (the local test build at
  `llama-dashboard/release/Llama Score Dashboard-win32-x64/` - see the
  `rebuild-llama-dashboard` skill for what that is and how to keep it
  current). `dev` runs `node_modules/electron/dist/electron.exe .` instead
  (reads source directly, no rebuild needed, but is a different code path -
  `main.js`'s `app.isPackaged` branches on this). Both clear
  `ELECTRON_RUN_AS_NODE` before spawning regardless of whether it's set in
  your shell.
- **`eval`** - `Runtime.evaluate` in the app's real page, `awaitPromise` +
  `returnByValue`. Use this to: click things
  (`document.querySelector(sel).click()` or `.dispatchEvent(new
  Event('change'))` for a `<select>`), read rendered output
  (`document.getElementById('modifierResults').innerHTML`), or call the
  exposed API directly (`window.llamaAPI.selectCampaign('<key>')`,
  `window.llamaAPI.listCampaigns()`). Prefer calling `window.llamaAPI.*`
  directly over simulating clicks when you just need data, not UI
  verification - it's the same IPC path a real click uses.
- **`listen`** - passively watches `Runtime.exceptionThrown` and
  `console.error` for the given duration (default 15s). Use this after
  triggering something (a tick, a form submit) to catch anything that fails
  silently in the background instead of showing a caught, rendered error.
- **`set-settings`** - calls `window.llamaAPI.saveSettings({saveDir,
  dataDir})` with paths JSON-escaped correctly. **Never hand-build this
  expression with manual backslash-doubling through bash -> node -> CDP** -
  an earlier session did that and it silently produced a garbled,
  wrong-but-not-obviously-wrong save path (logged a mangled directory
  string, watched nothing real, no error thrown). `JSON.stringify` on the
  path handles Windows backslashes correctly in one pass; this command
  already does that for you.
- **`quit`** - `taskkill`s the packaged exe by name. For a `dev`-mode
  instance, just close its window or `Get-Process electron | Stop-Process`
  (image name is ambiguous with any other running Electron app, so `quit`
  doesn't attempt it).

## Recipe: verify a change end-to-end against real data

```bash
# 1. rebuild if you changed source (see rebuild-llama-dashboard skill)
# 2. launch with debugging
node .claude/skills/drive-llama-dashboard/driver.js launch packaged
# 3. pin a specific campaign instead of whatever's "latest"
node .claude/skills/drive-llama-dashboard/driver.js eval "window.llamaAPI.selectCampaign('<campaign-key>')"
# 4. drive the UI - example: select a country and submit the modifier form
node .claude/skills/drive-llama-dashboard/driver.js eval "
document.getElementById('modifierOptimizerCountry').value = '203';
document.getElementById('modifierOptimizerCountry').dispatchEvent(new Event('change'));
document.getElementById('modifierKey').value = 'selling_efficiency';
document.getElementById('modifierForm').requestSubmit();
'submitted'
"
# 5. give it a moment, then read the rendered result
node .claude/skills/drive-llama-dashboard/driver.js eval "document.getElementById('modifierResults').innerText"
# 6. check nothing threw in the background
node .claude/skills/drive-llama-dashboard/driver.js listen 5000
# 7. clean up
node .claude/skills/drive-llama-dashboard/driver.js quit
```

## Gotchas

- `eval`/`listen` each open a fresh WebSocket and close it when done - no
  persistent driver process to manage, unlike a REPL-style driver. Fine for
  sequential calls; don't expect state between them beyond what's already
  in the app's own `window`/`localStorage`.
- If you changed `saveDir`/`dataDir` via `set-settings` for a scratch test,
  **restore the real values before finishing** (real `saveDir` is
  `C:\Users\samca\Documents\Paradox Interactive\Europa Universalis V\save
  games`; pass `dataDir` as `""` to clear an override back to the
  packaged-app default rather than leaving a scratch path pinned - an empty
  string deletes the override key rather than writing an empty string, per
  `main.js`'s `settings:save` handler).
- A CDP target list can include a `devtools://` entry alongside the real
  `file://` page - `findPageWsUrl()` in `driver.js` already filters for the
  real page, but keep this in mind if you extend the driver.
