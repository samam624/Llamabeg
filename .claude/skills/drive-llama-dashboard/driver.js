#!/usr/bin/env node
// CDP driver for the Llama Score Dashboard Electron app. No Playwright/
// playwright-core dependency - Node 22+ ships a native WebSocket client,
// which is all a CDP connection needs (a JSON handshake fetch + one
// WebSocket). This exists specifically to avoid OS-level screenshot/click
// automation: in this environment that's both unreliable (DPI-awareness
// mismatches, wrong-window focus) and risky (a screenshot attempt on
// 2026-07-18 captured unrelated content from the user's real screen instead
// of the app window). Driving the app's own JS context via CDP has neither
// problem.
//
// Usage:
//   node driver.js launch [packaged|dev]   default: packaged
//   node driver.js eval "<js expression>"  Runtime.evaluate, prints the result
//   node driver.js listen [ms]             passively watch for exceptions/console errors (default 15000)
//   node driver.js set-settings <saveDir> <dataDir>   safe-escaped window.llamaAPI.saveSettings call
//   node driver.js quit                    taskkill the packaged exe
//
// `eval`/`listen`/`set-settings` all just need port 9222 already listening -
// they reconnect fresh each call, so you can run several `eval`s back to
// back without keeping a process alive yourself.
"use strict";
const { spawn, execSync } = require("child_process");
const path = require("path");

const APP_DIR = path.join(__dirname, "..", "..", "..", "llama-dashboard");
const PACKAGED_EXE = path.join(APP_DIR, "release", "Llama Score Dashboard-win32-x64", "Llama Score Dashboard.exe");
const DEV_ELECTRON = path.join(APP_DIR, "node_modules", "electron", "dist", "electron.exe");
const DEBUG_PORT = 9222;

async function findPageWsUrl() {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`);
  const list = await res.json();
  const page = list.find((p) => p.type === "page" && p.url && p.url.startsWith("file://") && !p.url.startsWith("devtools://"));
  if (!page) throw new Error(`No app page found among ${list.length} CDP targets - is the app actually launched with --remote-debugging-port=${DEBUG_PORT}?`);
  return page.webSocketDebuggerUrl;
}

function cdpEval(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 1;
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: id++, method: "Runtime.enable" }));
      ws.send(JSON.stringify({ id: id++, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id === 2) {
        ws.close();
        if (msg.result && msg.result.exceptionDetails) reject(new Error(JSON.stringify(msg.result.exceptionDetails)));
        else resolve(msg.result && msg.result.result);
      }
    });
    ws.addEventListener("error", (e) => reject(new Error(e.message || "WebSocket error")));
    setTimeout(() => reject(new Error("CDP eval timed out after 15s")), 15000);
  });
}

function cdpListen(wsUrl, durationMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const findings = [];
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
      ws.send(JSON.stringify({ id: 2, method: "Log.enable" }));
    });
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === "Runtime.exceptionThrown") findings.push({ type: "EXCEPTION", detail: msg.params.exceptionDetails });
      if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        findings.push({ type: "CONSOLE.ERROR", detail: (msg.params.args || []).map((a) => a.value ?? a.description).join(" ") });
      }
    });
    ws.addEventListener("error", (e) => reject(new Error(e.message || "WebSocket error")));
    setTimeout(() => {
      ws.close();
      resolve(findings);
    }, durationMs);
  });
}

async function waitForPort(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await findPageWsUrl();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

async function main() {
  const [, , cmd, ...args] = process.argv;

  if (cmd === "launch") {
    const mode = args[0] || "packaged";
    const exe = mode === "dev" ? DEV_ELECTRON : PACKAGED_EXE;
    const spawnArgs = mode === "dev" ? [".", `--remote-debugging-port=${DEBUG_PORT}`] : [`--remote-debugging-port=${DEBUG_PORT}`];
    const cwd = mode === "dev" ? APP_DIR : path.dirname(PACKAGED_EXE);
    // ELECTRON_RUN_AS_NODE=1 in the parent shell would make this run as
    // plain Node instead of a real Electron GUI process - explicitly
    // cleared here regardless of whether it's set in the calling shell.
    const env = Object.assign({}, process.env);
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(exe, spawnArgs, { cwd, env, detached: true, stdio: "ignore" });
    child.unref();
    console.log(`launched ${mode} (pid ${child.pid}), waiting for CDP port...`);
    const ready = await waitForPort(15000);
    console.log(ready ? "ready." : "TIMEOUT waiting for CDP port - check the app actually opened a window.");
    return;
  }

  if (cmd === "eval") {
    const expression = args[0];
    if (!expression) throw new Error('usage: node driver.js eval "<js expression>"');
    const wsUrl = await findPageWsUrl();
    const result = await cdpEval(wsUrl, expression);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === "listen") {
    const ms = Number(args[0]) || 15000;
    const wsUrl = await findPageWsUrl();
    console.log(`listening for ${ms}ms...`);
    const findings = await cdpListen(wsUrl, ms);
    console.log(findings.length ? JSON.stringify(findings, null, 2) : "no exceptions or console errors observed");
    return;
  }

  if (cmd === "set-settings") {
    const [saveDir, dataDir] = args;
    if (saveDir === undefined) throw new Error("usage: node driver.js set-settings <saveDir> <dataDir|''>");
    const wsUrl = await findPageWsUrl();
    // JSON.stringify (not manual backslash-doubling) is what correctly
    // escapes a Windows path into a JS string literal here - hand-escaping
    // backslashes across bash -> node -> CDP expression layers is exactly
    // what produced a garbled, silently-wrong save path in an earlier
    // session (looked like it worked, logged a mangled directory instead).
    const expr = `window.llamaAPI.saveSettings(${JSON.stringify({ saveDir, dataDir: dataDir || "" })}).then(r => JSON.stringify(r))`;
    const result = await cdpEval(wsUrl, expr);
    console.log(result);
    return;
  }

  if (cmd === "quit") {
    try {
      execSync('taskkill /IM "Llama Score Dashboard.exe" /F', { stdio: "ignore" });
      console.log("closed.");
    } catch {
      console.log("nothing running (or already closed).");
    }
    return;
  }

  console.log("commands: launch [packaged|dev], eval \"<js>\", listen [ms], set-settings <saveDir> <dataDir>, quit");
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
