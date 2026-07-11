// Optional integration with the recorder's data/ folder via the File System
// Access API, so once a folder is granted once, the Llama Score panel can
// find and re-read the CURRENT campaign's ledger on its own - no manual
// "Choose File" round trip every time the recorder appends new data.
//
// Chromium-only (Firefox/Safari don't implement showDirectoryPicker as of
// this writing) - js/app.js keeps the plain <input type=file> pickers as the
// universal fallback when `supported` is false or the user declines.
//
// A granted directory handle is structured-cloneable and can be stored
// directly in IndexedDB (a documented capability of this API, specifically
// so a site can remember "yes, this folder" across page reloads without
// re-prompting a full OS file dialog every time - only a lightweight
// permission re-grant via requestPermission(), which still needs a user
// gesture but no browsing).
(function (root) {
  "use strict";

  const DB_NAME = "eu5-save-analyzer-ledger";
  const DB_VERSION = 1;
  const STORE = "handles";
  const HANDLE_KEY = "dataDir";

  const supported = typeof window !== "undefined" && "showDirectoryPicker" in window && typeof indexedDB !== "undefined";

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveHandle(handle) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(handle, HANDLE_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  async function loadHandle() {
    const db = await openDb();
    const handle = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(HANDLE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return handle;
  }

  async function clearHandle() {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(HANDLE_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  // Chrome re-prompts for permission on most new page loads even for a
  // remembered handle - queryPermission checks without prompting,
  // requestPermission prompts (needs a user gesture, e.g. inside a click
  // handler) and only be called when the caller has one to spend.
  async function verifyPermission(handle, requestIfNeeded) {
    const opts = { mode: "read" };
    if ((await handle.queryPermission(opts)) === "granted") return true;
    if (requestIfNeeded && (await handle.requestPermission(opts)) === "granted") return true;
    return false;
  }

  // The recorder writes data/campaigns/<uuid>/{snapshots,war-events}.jsonl
  // (see llama-score-automatic-logging-machine/README.md). Given a handle on
  // that top-level data/ folder, find the campaign whose snapshots.jsonl was
  // written to most recently - mirrors the recorder's own "latest campaign"
  // default, so the panel tracks whichever campaign is actively being played
  // without the user typing a UUID anywhere.
  async function findLatestCampaign(dataDirHandle) {
    const campaignsDir = await dataDirHandle.getDirectoryHandle("campaigns").catch(() => null);
    if (!campaignsDir) return null;
    let best = null;
    for await (const [name, handle] of campaignsDir.entries()) {
      if (handle.kind !== "directory") continue;
      const snapshotsHandle = await handle.getFileHandle("snapshots.jsonl").catch(() => null);
      if (!snapshotsHandle) continue;
      const file = await snapshotsHandle.getFile();
      if (!best || file.lastModified > best.lastModified) {
        best = { campaignKey: name, dirHandle: handle, lastModified: file.lastModified };
      }
    }
    return best;
  }

  // Direct lookup of ONE known campaign by key (the recorder names each
  // campaign's folder after its autosave UUID - see campaignKeyFromFile()
  // in llama-score-automatic-logging-machine/llama-log-machine.js), so a
  // save's own filename is enough to find its matching ledger without
  // scanning every campaign the way findLatestCampaign does.
  async function findCampaignByKey(dataDirHandle, campaignKey) {
    const campaignsDir = await dataDirHandle.getDirectoryHandle("campaigns").catch(() => null);
    if (!campaignsDir) return null;
    const dirHandle = await campaignsDir.getDirectoryHandle(campaignKey).catch(() => null);
    if (!dirHandle) return null;
    const snapshotsHandle = await dirHandle.getFileHandle("snapshots.jsonl").catch(() => null);
    if (!snapshotsHandle) return null;
    const file = await snapshotsHandle.getFile();
    return { campaignKey, dirHandle, lastModified: file.lastModified };
  }

  async function readJsonlFile(dirHandle, name) {
    const fileHandle = await dirHandle.getFileHandle(name).catch(() => null);
    if (!fileHandle) return { records: [], lastModified: 0 };
    const file = await fileHandle.getFile();
    const text = await file.text();
    const records = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch (err) {
        // Skip a malformed line (the recorder was mid-write when read).
      }
    }
    return { records, lastModified: file.lastModified };
  }

  async function readCampaignLedger(campaignDirHandle) {
    const [snapshots, events] = await Promise.all([readJsonlFile(campaignDirHandle, "snapshots.jsonl"), readJsonlFile(campaignDirHandle, "war-events.jsonl")]);
    return { snapshots: snapshots.records, events: events.records, lastModified: Math.max(snapshots.lastModified, events.lastModified) };
  }

  root.LedgerConnect = { supported, saveHandle, loadHandle, clearHandle, verifyPermission, findLatestCampaign, findCampaignByKey, readCampaignLedger };
})(typeof self !== "undefined" ? self : this);
