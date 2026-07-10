// Local (per-browser) library of every save this browser has parsed, kept in
// IndexedDB rather than localStorage - a full parsed result (locations alone
// runs to ~28k entries) is well past localStorage's ~5-10MB quota, and
// IndexedDB has no such practical ceiling. Lets a past save be reopened
// instantly (no re-parsing) and gives js/app.js's shareable-URL feature a
// stable id to resolve against.
(function (root) {
  "use strict";

  const DB_NAME = "eu5-save-analyzer";
  const DB_VERSION = 1;
  const STORE = "saves";

  const available = typeof indexedDB !== "undefined";

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // Derives a stable id from a parsed result rather than the uploaded
  // filename, so re-uploading the exact same save (autosaves get renamed/
  // copied a lot) dedupes to one library entry instead of piling up
  // duplicates under different filenames.
  function deriveSaveId(result) {
    const meta = (result && result.metadata) || {};
    const playthroughId = meta.playthrough_id !== undefined && meta.playthrough_id !== null ? meta.playthrough_id : "unknown";
    const date = meta.date || "unknown";
    return `${playthroughId}_${date}`;
  }

  async function put(fileName, result) {
    if (!available) return null;
    const db = await openDb();
    const id = deriveSaveId(result);
    const meta = result.metadata || {};
    const record = {
      id,
      fileName,
      uploadedAt: Date.now(),
      gameDate: meta.date || null,
      playthroughName: meta.playthrough_name || null,
      playerCountryName: meta.player_country_name || null,
      result,
    };
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(record);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return id;
  }

  async function get(id) {
    if (!available) return null;
    const db = await openDb();
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return record;
  }

  // Listing shouldn't ship every save's full parsed result (countries,
  // ~28k locations, ...) just to render a picker row - callers that need
  // the full result for a specific entry should follow up with get(id).
  async function list() {
    if (!available) return [];
    const db = await openDb();
    const records = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return records.map(({ result, ...meta }) => meta);
  }

  async function remove(id) {
    if (!available) return;
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  root.SaveLibrary = { available, deriveSaveId, put, get, list, remove };
})(typeof self !== "undefined" ? self : this);
