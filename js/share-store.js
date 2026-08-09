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

  // Fetch a campaign's full recorder ledger (snapshots + war-events) via
  // eu5_get_campaign/eu5_get_campaign_snapshots_page/eu5_get_campaign_events_page
  // (see supabase/migrations/20260809190000_eu5_get_campaign_ledger_chunked_rpc.sql)
  // - the server-side twin of js/ledger-connect.js's readCampaignLedger, for
  // whenever a browser has no local recorder folder connected (e.g. someone
  // opening a ?save= link who was never running the Dashboard themselves).
  // Rows only exist here once the campaign's owner has run `npm run
  // data:import` - a manual, service-role-keyed step deliberately kept out
  // of the browser (the anon key used here only ever gets read/SELECT
  // access, per that migration's RLS policies).
  // Paginated rather than one combined call: a real campaign that grew to
  // 103 snapshots + 179 events (~14MB combined) blew the anon role's
  // statement timeout when eu5_get_campaign_ledger tried to jsonb_agg both
  // in a single query (confirmed directly: 57014 canceling statement due to
  // statement timeout) - silently breaking "Share link" for any recipient
  // of a long-running campaign, with no error surfaced anywhere. Each half
  // alone easily succeeds (measured: 103-row snapshots page ~2.6s/12MB,
  // 179-row events page ~0.8s/1.8MB), so paging comfortably below that,
  // rather than matching today's exact sizes, keeps this from recurring as
  // the same still-active campaign keeps growing.
  // Returns null if unconfigured, the campaign isn't imported, or the
  // request fails - callers treat null as "no shared ledger, fall back."
  const LEDGER_READ_SNAPSHOT_PAGE_SIZE = 25;
  const LEDGER_READ_EVENT_PAGE_SIZE = 100;

  async function callReadRpc(fn, body) {
    const c = config();
    const res = await fetch(`${c.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        apikey: c.supabaseAnonKey,
        Authorization: `Bearer ${c.supabaseAnonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${fn} failed (${res.status})`);
    return res.json();
  }

  async function fetchAllPages(fn, campaignKey, pageSize) {
    const all = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await callReadRpc(fn, { p_campaign_key: campaignKey, p_offset: offset, p_limit: pageSize });
      if (!Array.isArray(page) || !page.length) break;
      all.push(...page);
      if (page.length < pageSize) break; // last page
    }
    return all;
  }

  async function fetchCampaignLedger(campaignKey) {
    const c = config();
    if (!c || !c.supabaseUrl || !c.supabaseAnonKey || !campaignKey) return null;
    const campaign = await callReadRpc("eu5_get_campaign", { p_campaign_key: campaignKey });
    if (!campaign) return null; // no campaign row for this key
    const [snapshots, events] = await Promise.all([
      fetchAllPages("eu5_get_campaign_snapshots_page", campaignKey, LEDGER_READ_SNAPSHOT_PAGE_SIZE),
      fetchAllPages("eu5_get_campaign_events_page", campaignKey, LEDGER_READ_EVENT_PAGE_SIZE),
    ]);
    return { campaign, snapshots, events };
  }

  // Chunk sizes mirror scripts/import-llama-ledgers-to-supabase.js's
  // TABLE_CHUNK_SIZES exactly - snapshot rows embed a large jsonb blob each,
  // and a single request carrying too many of them hits the anon role's
  // statement timeout (measured directly: 49 snapshots + 116 events in one
  // combined call timed out; this project's own service-role CLI importer
  // already learned the same lesson and chunks snapshots one at a time).
  const LEDGER_SNAPSHOT_CHUNK_SIZE = 1;
  const LEDGER_EVENT_CHUNK_SIZE = 100;

  async function callLedgerRpc(fn, body) {
    const c = config();
    if (!c || !c.supabaseUrl || !c.supabaseAnonKey) throw new Error("Sharing backend not configured");
    const res = await fetch(`${c.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        apikey: c.supabaseAnonKey,
        Authorization: `Bearer ${c.supabaseAnonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ledger upload failed (${fn}, ${res.status}) ${text.slice(0, 200)}`);
    }
  }

  // Runs `tasks` (a list of zero-arg functions returning promises) with at
  // most `limit` in flight at once, instead of either all-at-once (can
  // overload the anon connection pool) or fully sequential (each chunk
  // waits on the full round-trip of the one before it, for no reason - the
  // chunk size itself, not the concurrency, is what keeps any one request
  // safe). This is what turns "Share link" on a real 100+-snapshot campaign
  // from 100+ sequential round-trips into ~limit-at-a-time.
  async function runWithLimit(tasks, limit) {
    const executing = new Set();
    for (const task of tasks) {
      const p = task().finally(() => executing.delete(p));
      executing.add(p);
      if (executing.size >= limit) await Promise.race(executing);
    }
    await Promise.all(executing);
  }

  const LEDGER_UPLOAD_CONCURRENCY = 6;

  // Push a campaign's ledger (already shaped by js/app.js's
  // shapeCampaignLedgerForUpload to match the eu5_campaigns/
  // eu5_campaign_snapshots/eu5_war_events row shapes) via three narrow
  // RPCs - the write-side twin of fetchCampaignLedger above. Anon-callable
  // by design (see that migration's comment) so "Share link" can push this
  // browser's own currently-linked ledger with no service-role key involved.
  // The campaign row must land first (snapshots/events both foreign-key to
  // it); the snapshot/event chunks themselves don't depend on each other,
  // so they're queued together and run with bounded concurrency - each
  // individual request is still exactly as small (and as safe under the
  // anon statement timeout) as before, this just stops waiting for each
  // one to fully finish before starting the next.
  async function uploadCampaignLedger(campaign, snapshots, events) {
    await callLedgerRpc("eu5_upsert_campaign", { p_campaign: campaign });
    const tasks = [];
    for (let i = 0; i < snapshots.length; i += LEDGER_SNAPSHOT_CHUNK_SIZE) {
      const chunk = snapshots.slice(i, i + LEDGER_SNAPSHOT_CHUNK_SIZE);
      tasks.push(() => callLedgerRpc("eu5_upsert_campaign_snapshots", { p_snapshots: chunk }));
    }
    for (let i = 0; i < events.length; i += LEDGER_EVENT_CHUNK_SIZE) {
      const chunk = events.slice(i, i + LEDGER_EVENT_CHUNK_SIZE);
      tasks.push(() => callLedgerRpc("eu5_upsert_campaign_events", { p_events: chunk }));
    }
    await runWithLimit(tasks, LEDGER_UPLOAD_CONCURRENCY);
  }

  // Persist a Black Death per-country death breakdown the moment a save
  // provides one, keyed by the save's own playthrough_id + the outbreak's
  // own identity number (see supabase/migrations/20260730080000_
  // eu5_black_death_captures.sql - this data is confirmed unrecoverable from
  // any 1.3.11+ save on its own, see docs/ARCHITECTURE.md). Best-effort by
  // design: callers fire this and ignore failures, since it's purely an
  // opportunistic cache write, never something the current save's own
  // rendering depends on.
  async function captureBlackDeath(playthroughId, identity, deathsByCountry, startDate, endDate, gameVersion) {
    if (!isConfigured() || !playthroughId || typeof identity !== "number" || !deathsByCountry) return;
    await callLedgerRpc("eu5_capture_black_death", {
      p_playthrough_id: String(playthroughId),
      p_outbreak_identity: identity,
      p_deaths_by_country: deathsByCountry,
      p_start_date: startDate || null,
      p_end_date: endDate || null,
      p_game_version: gameVersion || null,
    });
  }

  // Look up a previously-captured breakdown for a save that no longer
  // carries the raw data itself. Returns null if unconfigured, never
  // captured, or the request fails - callers treat null as "no capture on
  // record," distinct from "the Black Death hasn't happened in this save."
  async function fetchBlackDeathCapture(playthroughId, identity) {
    if (!isConfigured() || !playthroughId || typeof identity !== "number") return null;
    const c = config();
    const url =
      `${c.supabaseUrl}/rest/v1/eu5_black_death_captures` +
      `?playthrough_id=eq.${encodeURIComponent(String(playthroughId))}` +
      `&outbreak_identity=eq.${identity}` +
      `&select=deaths_by_country,captured_at&limit=1`;
    const res = await fetch(url, {
      headers: { apikey: c.supabaseAnonKey, Authorization: `Bearer ${c.supabaseAnonKey}` },
    }).catch(() => null);
    if (!res || !res.ok) return null;
    const rows = await res.json().catch(() => null);
    if (!Array.isArray(rows) || !rows.length || !rows[0].deaths_by_country) return null;
    return rows[0].deaths_by_country;
  }

  root.ShareStore = {
    isConfigured,
    upload,
    fetch: fetchShared,
    fetchCampaignLedger,
    uploadCampaignLedger,
    captureBlackDeath,
    fetchBlackDeathCapture,
    BUCKET,
  };
})(typeof self !== "undefined" ? self : this);
