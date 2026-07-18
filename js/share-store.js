// Shared-save backend: uploads a gzip-compressed copy of a parsed save to
// Supabase Storage so a "?save=<id>" link resolves for someone who never
// uploaded that save themselves (js/app.js's share-URL flow otherwise only
// works against this browser's own local history - see js/save-library.js).
//
// Why the compressed PARSED RESULT and not the raw .eu5: measured on a real
// late-game save, the raw .eu5 is ~63MB and the parsed result gzips to
// ~5.6MB (11x less) - AND the recipient just decompresses + JSON.parse's it
// instead of re-running the multi-second 60MB binary parse. See the
// CHANGELOG entry for the full measurement.
//
// Talks to Supabase Storage's REST API over plain fetch - deliberately no
// supabase-js SDK, both to keep the strict production CSP intact
// (script-src 'self', see netlify.toml) and because the two calls we need
// (upload one object, GET one public object) don't warrant a bundled client.
// Config (the PUBLIC project URL + anon key) arrives via window.EU5_CONFIG,
// set by config.js (at the site root) - generated at build time on Netlify
// and by scripts/write-config.js locally; absent in a plain checkout, in
// which case isConfigured() is false and the app cleanly falls back to
// local-only sharing.
(function (root) {
  "use strict";

  const BUCKET = "shared-saves";

  function config() {
    return (typeof root.EU5_CONFIG === "object" && root.EU5_CONFIG) || null;
  }

  // The whole feature no-ops (and the UI degrades to the old local-only
  // "Copy link") unless BOTH a backend is configured AND this browser can
  // gzip - CompressionStream/DecompressionStream are the native primitives
  // used below (no library), shipped everywhere current but worth guarding.
  const canCompress = typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";

  function isConfigured() {
    const c = config();
    return !!(c && c.supabaseUrl && c.supabaseAnonKey && canCompress);
  }

  async function gzip(str) {
    const stream = new Blob([str]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Response(stream).arrayBuffer();
  }

  async function gunzip(arrayBuffer) {
    const stream = new Blob([arrayBuffer]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }

  // saveId is "<playthrough_uuid>_<game_date>" (see save-library.js's
  // deriveSaveId) - encode it so an unusual date/label can't break the path.
  function objectPath(saveId) {
    return encodeURIComponent(saveId) + ".json.gz";
  }

  // Upload the compressed result. Idempotent by construction: the saveId is
  // deterministic, so re-sharing the same save overwrites its own object
  // (x-upsert) rather than piling up duplicates. Resolves to the number of
  // compressed bytes stored (handy for the UI), throws on a real failure.
  async function upload(saveId, resultPayload) {
    if (!isConfigured()) throw new Error("Sharing backend not configured");
    const c = config();
    const gz = await gzip(JSON.stringify(resultPayload));
    const url = `${c.supabaseUrl}/storage/v1/object/${BUCKET}/${objectPath(saveId)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        apikey: c.supabaseAnonKey,
        Authorization: `Bearer ${c.supabaseAnonKey}`,
        "Content-Type": "application/gzip",
        "Cache-Control": "public, max-age=31536000, immutable",
        "x-upsert": "true",
      },
      body: gz,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Upload failed (${res.status}) ${body.slice(0, 200)}`);
    }
    return gz.byteLength;
  }

  // Fetch + decompress a shared save. Returns the parsed result object, or
  // null if this save isn't shared (404) or no backend is configured -
  // callers treat null as "fall back to asking the user to drop the file in."
  async function fetchShared(saveId) {
    if (!isConfigured()) return null;
    const c = config();
    const url = `${c.supabaseUrl}/storage/v1/object/public/${BUCKET}/${objectPath(saveId)}`;
    const res = await fetch(url);
    if (res.status === 404 || res.status === 400) return null; // not shared / missing bucket
    if (!res.ok) throw new Error(`Could not load shared save (${res.status})`);
    const json = await gunzip(await res.arrayBuffer());
    return JSON.parse(json);
  }

  root.ShareStore = { isConfigured, upload, fetch: fetchShared, BUCKET };
})(typeof self !== "undefined" ? self : this);
