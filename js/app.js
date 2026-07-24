(function () {
  "use strict";

  const fileInput = document.getElementById("fileInput");
  const homeStartBtn = document.getElementById("homeStartBtn");
  const dropzone = document.getElementById("dropzone");
  const dropzoneText = document.getElementById("dropzoneText");
  const uploaderSummaryEl = document.getElementById("uploaderSummary");
  const uploaderSummaryTextEl = document.getElementById("uploaderSummaryText");
  const changeFileBtn = document.getElementById("changeFileBtn");
  const statusEl = document.getElementById("status");
  const statusText = document.getElementById("statusText");
  const progressFill = document.getElementById("progressFill");
  const errorBox = document.getElementById("errorBox");
  const mapContainerEl = document.getElementById("mapContainer");
  const overviewEl = document.getElementById("overview");
  const playersTableEl = document.getElementById("playersTable");
  const countriesTableEl = document.getElementById("countriesTable");
  const playerCountEl = document.getElementById("playerCount");
  const countryCountEl = document.getElementById("countryCount");
  const countrySearch = document.getElementById("countrySearch");
  const blackDeathSummaryEl = document.getElementById("blackDeathSummary");
  const blackDeathTableEl = document.getElementById("blackDeathTable");
  const llamaSnapshotsInput = document.getElementById("llamaSnapshotsInput");
  const llamaEventsInput = document.getElementById("llamaEventsInput");
  const llamaLedgerStatusEl = document.getElementById("llamaLedgerStatus");
  const llamaManualLoaderEl = document.getElementById("llamaManualLoader");
  const llamaConnectBtn = document.getElementById("llamaConnectBtn");
  const llamaDisconnectBtn = document.getElementById("llamaDisconnectBtn");
  const llamaShowToggleEl = document.getElementById("llamaShowToggle");
  const llamaAutoStatusEl = document.getElementById("llamaAutoStatus");
  const llamaWarModalEl = document.getElementById("llamaWarModal");
  const llamaWarDetailsBtn = document.getElementById("llamaWarDetailsBtn");
  const llamaWarModalCloseBtn = document.getElementById("llamaWarModalClose");
  const llamaShowAiWarsEl = document.getElementById("llamaShowAiWars");
  const llamaShowAiWarsLabelEl = document.getElementById("llamaShowAiWarsLabel");
  const llamaModePvpBtn = document.getElementById("llamaModePvp");
  const llamaModePveBtn = document.getElementById("llamaModePve");
  const llamaModeNoteEl = document.getElementById("llamaModeNote");
  const llamaH2HHeadingEl = document.getElementById("llamaH2HHeading");
  const llamaH2HNoteEl = document.getElementById("llamaH2HNote");
  const llamaLinkStatusEl = document.getElementById("llamaLinkStatus");
  const savesLibraryPanel = document.getElementById("savesLibraryPanel");
  const savesLibraryTableEl = document.getElementById("savesLibraryTable");
  const copyLinkBtn = document.getElementById("copyLinkBtn");
  const copyPlayersImageBtn = document.getElementById("copyPlayersImageBtn");
  const copyBlackDeathImageBtn = document.getElementById("copyBlackDeathImageBtn");
  const copyCountriesImageBtn = document.getElementById("copyCountriesImageBtn");
  const copyTrendsImageBtn = document.getElementById("copyTrendsImageBtn");
  const themeToggleBtn = document.getElementById("themeToggleBtn");
  const pendingShareNoticeEl = document.getElementById("pendingShareNotice");
  const countryMetricTabs = document.querySelectorAll("#metricTabs .metric-tab");
  const playerMetricTabs = document.querySelectorAll("#playerMetricTabs .metric-tab");
  const tabButtons = document.querySelectorAll(".app-tab");
  const llamaTabBtn = document.getElementById("llamaTabBtn");
  const tabPanels = {
    home: document.getElementById("homeTab"),
    load: document.getElementById("loadTab"),
    metrics: document.getElementById("metricsTab"),
    graphs: document.getElementById("graphsTab"),
    llama: document.getElementById("llamaTab"),
    map: document.getElementById("mapTab"),
  };
  const VALID_TABS = Object.keys(tabPanels);
  // Hidden until a save has actually been parsed - there's nothing to show
  // on them before that (see setResultTabsAvailable, called from onParsed).
  const RESULT_ONLY_TAB_KEYS = ["metrics", "graphs", "map"];

  let latestCountries = [];
  let latestResult = null;
  let mapRenderedForResult = false;
  let currentMetricGroup = "key";
  let currentPlayerMetricGroup = "key";
  let currentTab = "home";
  let llamaSnapshotsLedger = null;
  let llamaEventsLedger = null;
  let ledgerConnection = null; // { dataDirHandle, campaignKey, lastModified } while auto-connected
  // Name -> in-game date they were marked departed as of, read from this
  // campaign's own hidden-players.json (written by the Llamabeg desktop
  // dashboard's Hide button - see llama-dashboard/main.js). Read-only here;
  // this app never writes that file itself, see getAllExcludedPlayers()/
  // excludedPlayersForScoring() below for how it's merged with the manual
  // Hide list.
  let sharedHiddenPlayers = new Map();
  let ledgerPollTimer = null;
  // The filename of whatever save is currently loaded - autosave_<uuid>.eu5
  // names carry the recorder's own campaign key, so this is what lets the
  // Llama Score panel find that campaign's ledger with no manual file
  // picking (see campaignKeyFromFilename/autoLinkLlamaForCurrentSave below).
  let currentSaveDisplayName = null;
  // True once ledger data is actually showing (auto-linked OR manually
  // connected/loaded) - drives whether the panel is visible at all when the
  // "Show Llama Score" checkbox is unchecked (see updateLlamaPanelVisibility).
  let llamaAutoLinked = false;
  let currentLlamaDraw = null; // stores the currently-active mode's draw() so the AI-wars toggle can re-render on demand
  const LLAMA_SHOW_TOGGLE_KEY = "eu5-analyzer-llama-show-toggle";
  const THEME_KEY = "eu5-analyzer-theme";
  // PVP (default) scores player-vs-player wars, same as always. PVE scores
  // the SAME wars/formula but for the opposite isPvP split - a player's
  // performance against AI - which doubles as a live sanity-check of the
  // PVP scoring logic itself (see js/llama-score.js's module comment on
  // computeLlamaScores' mode param). Persisted so reloading the page keeps
  // whichever mode was last selected.
  const LLAMA_MODE_KEY = "eu5-analyzer-llama-mode";
  const ASSET_VERSION = "v1.3.6";
  let llamaScoreMode = localStorage.getItem(LLAMA_MODE_KEY) === "pve" ? "pve" : "pvp";
  let currentEstateMetricGroup = "commoners";
  // Set when the page loads with a ?save=<id> URL that isn't in this
  // browser's local history yet - see initFromShareUrl()/onParsed().
  let pendingShareId = null;
  let pendingShareTab = "metrics";

  function activateTab(tab) {
    if (!tabPanels[tab]) tab = "home";
    currentTab = tab;
    document.body.classList.toggle("map-view-active", tab === "map");
    document.body.classList.toggle("home-view-active", tab === "home");
    if (tab === "map") window.scrollTo(0, 0);
    tabButtons.forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    Object.entries(tabPanels).forEach(([key, panel]) => {
      if (panel) panel.hidden = key !== tab;
    });
    if (tab === "map" && latestResult && !mapRenderedForResult) renderMap(latestResult);
    updateShareUrl();
  }

  // Metrics/Graphs/Map only have anything to show once a save has been
  // parsed - hidden from the tab bar (rather than just showing empty) until
  // then. Llama Score has its own, separate visibility rule (see
  // updateLlamaPanelVisibility) since it can populate from a standalone
  // recorder ledger connection with no save loaded at all.
  function setResultTabsAvailable(available) {
    RESULT_ONLY_TAB_KEYS.forEach((key) => {
      const btn = document.querySelector(`.app-tab[data-tab="${key}"]`);
      if (btn) btn.hidden = !available;
    });
  }

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => activateTab(btn.dataset.tab));
  });

  if (homeStartBtn) homeStartBtn.addEventListener("click", () => activateTab("load"));

  countryMetricTabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      const previousMetricGroup = currentMetricGroup;
      currentMetricGroup = btn.dataset.metrics || "key";
      try {
        drawCountryTable();
        countryMetricTabs.forEach((b) => b.classList.toggle("active", b === btn));
      } catch (err) {
        currentMetricGroup = previousMetricGroup;
        renderTableError(countriesTableEl, err);
      }
    });
  });

  playerMetricTabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      const previousMetricGroup = currentPlayerMetricGroup;
      currentPlayerMetricGroup = btn.dataset.metrics || "key";
      try {
        drawPlayerTable();
        playerMetricTabs.forEach((b) => b.classList.toggle("active", b === btn));
      } catch (err) {
        currentPlayerMetricGroup = previousMetricGroup;
        renderTableError(playersTableEl, err);
      }
    });
  });

  // Manual exclude list for players who've left the campaign for good. A
  // single save has no "still connected" flag (it's a snapshot of game
  // state, not a live session roster) - a departed player still shows as
  // the country's last controller same as anyone else, so there's no
  // reliable way to auto-detect "gone and not coming back" from a lone save
  // alone. This list is the manual override for that case (or just "I know
  // better, hide this one"), persisted so it survives reloading the same
  // save. See getAllExcludedPlayers() below for the automatic companion,
  // which DOES have a reliable signal once the desktop tracker's campaign
  // ledger is linked (multiple snapshots over time, not just one).
  const EXCLUDED_PLAYERS_KEY = "eu5-analyzer-excluded-players";
  function getExcludedPlayers() {
    try {
      return new Set(JSON.parse(localStorage.getItem(EXCLUDED_PLAYERS_KEY) || "[]"));
    } catch (err) {
      return new Set();
    }
  }
  function setExcludedPlayers(set) {
    localStorage.setItem(EXCLUDED_PLAYERS_KEY, JSON.stringify([...set]));
  }

  // Union of the manual hide list above with whoever the desktop tracker's
  // campaign ledger shows as departed as of its latest snapshot (see
  // LlamaScore.computeDepartedPlayers) - the automatic half of "hide a
  // player" the user asked for, alongside the manual Hide button. Only
  // available once a campaign ledger is linked (llamaSnapshotsLedger is
  // null otherwise, e.g. no recorder data for this save); falls back to
  // just the manual list in that case, same as before this existed. This is
  // the read path used everywhere a player should actually disappear from
  // view (Players table, Trends, the Map) - getExcludedPlayers() itself
  // stays the raw manual set, since the Hide/Show buttons read AND WRITE it
  // directly and shouldn't accidentally persist an auto-detected name into
  // permanent manual storage.
  // Name -> departed-as-of date, computed fresh from the ledger every call -
  // "every automation flag enabled at once" (see js/llama-score.js's
  // isFullyAutomated/computeAutomationDepartures) is the third automatic
  // departure signal alongside roster-change detection and the shared Hide
  // file, per the user's explicit call after confirming the real-data
  // pattern. Requires a ledger (single-save mode has no automatedSystems
  // history to walk).
  function computeAutomationDeparturesForCurrentLedger() {
    if (!llamaSnapshotsLedger || !llamaSnapshotsLedger.length || typeof LlamaScore === "undefined" || !LlamaScore.computeAutomationDepartures) return new Map();
    try {
      const campaignKey = pickLatestCampaignKey(llamaSnapshotsLedger) || "campaign";
      const { snapshots } = filterLedgerToCampaign(llamaSnapshotsLedger, llamaEventsLedger, campaignKey);
      return LlamaScore.computeAutomationDepartures(snapshots);
    } catch (err) {
      return new Map(); // Ledger data mid-write or otherwise malformed - fall back to nothing extra.
    }
  }

  function getAllExcludedPlayers() {
    const excluded = getExcludedPlayers();
    if (llamaSnapshotsLedger && llamaSnapshotsLedger.length && typeof LlamaScore !== "undefined" && LlamaScore.computeDepartedPlayers) {
      try {
        const campaignKey = pickLatestCampaignKey(llamaSnapshotsLedger) || "campaign";
        const { snapshots } = filterLedgerToCampaign(llamaSnapshotsLedger, llamaEventsLedger, campaignKey);
        for (const name of LlamaScore.computeDepartedPlayers(snapshots)) excluded.add(name);
      } catch (err) {
        // Ledger data mid-write or otherwise malformed - fall back to just the manual list.
      }
    }
    for (const name of computeAutomationDeparturesForCurrentLedger().keys()) excluded.add(name);
    // Anyone hidden via Llamabeg's Hide button (see sharedHiddenPlayers'
    // comment above) should disappear from this app's current-state views
    // too, without the user needing to hide them a second time here.
    for (const name of sharedHiddenPlayers.keys()) excluded.add(name);
    return excluded;
  }

  // The manual list + shared file + automation-detected departures, MERGED
  // as a Map (name -> departed-as-of date or null) rather than flattened to
  // a bare Set of names - this is what the ledger-based Llama Score panel's
  // computeFromLedger call needs so a dated departure only excludes wars
  // that started after that date, while the manual Hide button here (no
  // date info, never has had any) keeps its existing all-or-nothing
  // behavior. See computeFromLedger's own comment in js/llama-score.js.
  function excludedPlayersForScoring() {
    const merged = new Map(sharedHiddenPlayers);
    for (const [name, date] of computeAutomationDeparturesForCurrentLedger()) if (!merged.has(name)) merged.set(name, date);
    for (const name of getExcludedPlayers()) if (!merged.has(name)) merged.set(name, null);
    return merged;
  }

  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
  });

  ["dragenter", "dragover"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("drag-over");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove("drag-over");
    })
  );
  dropzone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  changeFileBtn.addEventListener("click", () => {
    uploaderSummaryEl.hidden = true;
    dropzone.hidden = false;
    activateTab("load");
  });

  function showError(message) {
    errorBox.innerHTML = message;
    errorBox.hidden = false;
  }

  function setStatus(message, fraction) {
    statusEl.hidden = false;
    statusText.textContent = message;
    if (typeof fraction === "number") {
      progressFill.style.width = Math.round(fraction * 100) + "%";
    }
  }

  async function handleFile(file) {
    errorBox.hidden = true;
    uploaderSummaryEl.hidden = true;
    dropzone.hidden = false;
    activateTab("load");
    dropzoneText.textContent = file.name;
    setStatus("Checking file format...", 0);

    let header;
    try {
      header = await file.slice(0, 7).text();
    } catch (err) {
      showError("Could not read the selected file: " + escapeHtml(err.message));
      return;
    }

    if (!header.startsWith("SAV")) {
      showError(
        "This doesn't look like an EU5 save file (missing the <code>SAV</code> header). " +
          "Make sure you selected a <code>.eu5</code> file."
      );
      statusEl.hidden = true;
      return;
    }

    const formatCode = header.slice(5, 7);
    if (formatCode !== "00" && formatCode !== "03") {
      showError(
        `Unrecognized EU5 save format (code "${escapeHtml(formatCode)}"). This tool understands melted ` +
          "(plaintext) and standard compressed saves, but not this variant."
      );
      statusEl.hidden = true;
      return;
    }

    runParse(file, formatCode);
  }

  function runParse(file, formatCode) {
    let worker;
    try {
      worker = new Worker(`js/parse-worker.js?v=${ASSET_VERSION}`);
    } catch (err) {
      worker = null;
    }

    if (worker) {
      worker.onmessage = (event) => {
        const msg = event.data;
        if (msg.type === "status") {
          setStatus(msg.message);
        } else if (msg.type === "progress") {
          setStatus(msg.fraction < 0.55 && formatCode === "03" ? "Melting save..." : "Parsing save...", msg.fraction);
        } else if (msg.type === "done") {
          onParsed(msg.result);
          worker.terminate();
        } else if (msg.type === "error") {
          showError("Failed to parse save: " + escapeHtml(msg.message));
          statusEl.hidden = true;
          worker.terminate();
        }
      };
      worker.onerror = () => {
        // Worker script failed to load (can happen when opened via file://
        // in some browsers) - fall back to parsing on the main thread.
        worker.terminate();
        runParseOnMainThread(file, formatCode);
      };
      worker.postMessage({ file });
    } else {
      runParseOnMainThread(file, formatCode);
    }
  }

  async function runParseOnMainThread(file, formatCode) {
    try {
      setStatus("Reading file...", 0);
      let result;
      if (formatCode === "03") {
        const arrayBuffer = await file.arrayBuffer();
        setStatus("Melting save...", 0);
        await new Promise((resolve) => setTimeout(resolve, 0));
        result = await ClausewitzBinary.parseCompressedSave(arrayBuffer, {
          includeLocations: true,
          includeWars: true,
          onProgress: (frac) => setStatus(frac < 0.55 ? "Melting save..." : "Parsing save...", frac),
        });
      } else {
        const text = await file.text();
        setStatus("Parsing save...", 0);
        // Yield to the browser so the "reading" status can paint before the
        // (synchronous, potentially multi-second) parse blocks the thread.
        await new Promise((resolve) => setTimeout(resolve, 0));
        result = Clausewitz.parseSave(text, {
          includeLocations: true,
          includeWars: true,
          onProgress: (frac) => setStatus("Parsing save...", frac),
        });
      }
      onParsed(result);
    } catch (err) {
      showError("Failed to parse save: " + escapeHtml(err.message));
      statusEl.hidden = true;
    }
  }

  function onParsed(result, options) {
    options = options || {};
    const displayName = options.displayName || dropzoneText.textContent;
    // Only auto-navigate away from the Load Save tab the FIRST time a save
    // lands (i.e. the user was actually looking at it) - reloading a
    // different save while already on Graphs/Llama/Map shouldn't yank the
    // view out from under them.
    const wasOnLoadTab = currentTab === "load";
    statusEl.hidden = true;
    dropzone.hidden = true;
    uploaderSummaryTextEl.textContent = `Loaded: ${displayName}`;
    uploaderSummaryEl.hidden = false;

    // A save loaded back out of local history (js/save-library.js) is the
    // exact result object a PAST version of this app parsed, not re-parsed
    // now - so a schema change since then (new fields a parser update
    // added, e.g. blackDeath.deathsByCountry) silently shows as missing
    // data with no indication why, instead of the "wrong version" issue it
    // actually is. The library only stores the parsed result, not the
    // original file, so there's nothing to auto-recover from - flag it and
    // let the user drop the stale entry and re-upload the original file.
    const missingPopulationRecords =
      Array.isArray(result.locations) &&
      result.locations.some((loc) => loc && Array.isArray(loc.popIds) && loc.popIds.length) &&
      (!Array.isArray(result.popRecords) || !result.popRecords.length);
    const missingEstateIncomeRecords = !Array.isArray(result.estateTradeIncomes);
    const staleParsedResult =
      (result.__schemaVersion !== undefined && result.__schemaVersion !== RESULT_SCHEMA_VERSION) ||
      missingPopulationRecords ||
      missingEstateIncomeRecords;
    if (staleParsedResult) {
      const canRemoveStale = options.persist === false && options.libraryId;
      const missingData = [];
      if (missingPopulationRecords) missingData.push("population database records");
      if (missingEstateIncomeRecords) missingData.push("per-estate income records");
      if (!missingData.length) missingData.push("newer fields (including estate tax rates)");
      showError(
        `This save was loaded from parsed data saved by an older version of this analyzer - some ${missingData.join(" and ")} may be missing until it's re-parsed. ` +
          `${canRemoveStale ? `<button type="button" id="staleCacheRemoveBtn" class="link-btn">Remove from history</button> and ` : ""}re-upload the original <code>.eu5</code> file to refresh it.`
      );
      const removeBtn = document.getElementById("staleCacheRemoveBtn");
      if (removeBtn) removeBtn.addEventListener("click", () => removeStaleLibraryEntry(options.libraryId));
    } else {
      errorBox.hidden = true;
    }

    latestResult = result;
    // Temporary debug hook (2026-07-17, Tax Income rollout) - exposes the
    // parsed result on window so a live-game issue can be diagnosed from
    // the browser console without the save ever leaving the machine. Safe
    // to leave in; remove once Tax Income is confirmed working across
    // patch versions.
    if (typeof window !== "undefined") window.__eu5Result = result;
    mapRenderedForResult = false;
    setResultTabsAvailable(true);
    if (wasOnLoadTab) activateTab("metrics");
    // Derived metrics (profit, efficiency, per-pop ratios) are read by both
    // the countries table and the players table - compute once, before
    // either renders, rather than only inside renderCountries() (which used
    // to run after renderPlayers(), so player rows briefly/always read
    // undefined for these).
    // State Trade Income and State Tax Income both have canonical
    // country-level last-completed-month fields. Do not sum the similarly
    // named estate_manager last_month.trade_income values here: those feed
    // the estates' private gold pools. The estate paid_taxes sum does equal
    // last_months_tax_income, but the direct field is authoritative and
    // remains available when the optional estate/location parse is omitted.
    result.countries.forEach((c) => {
      c.__isPlayerCountry = c.players && c.players.length > 0;
      c.tradeIncome = c.lastMonthsTradeIncome;
      c.taxIncome = c.lastMonthsTaxIncome;
      computeDerivedMetrics(c);
    });
    // Army Size/Levies/Regulars/Mercenaries (above, via attachArmyCounts) are
    // bare regiment COUNTS - a country with 10 nearly-wiped-out regiments and
    // one with 10 full-strength ones show identically. The "(k)" columns show
    // real troop HEADCOUNTS instead, and the save already carries them: each
    // subunit's `strength` field IS its current troop count, in the exact same
    // "thousands" unit as population/manpower (strength 0.40 = 400 troops).
    // Proven two ways against a real save: (1) a Byzantine cataphract regiment
    // at strength 0.40 shows as exactly 400 men in-game, an archer at 0.50 as
    // 500; (2) across 2003 regiments, strength*1000 NEVER exceeds that unit
    // type's own max capacity and lands exactly at it for the 1156 full ones.
    // So the "(k)" figure is simply the sum of strength values - no unit-size
    // table, no game-install files, no age/bonus math needed (an earlier
    // version multiplied strength by a separately-derived max size, which
    // double-counted and read ~2.5x low).
    const troopsByCountry = new Map();
    for (const troop of result.armySubunitDetails || []) {
      if (typeof troop.controller !== "number" || typeof troop.strength !== "number") continue;
      if (!troopsByCountry.has(troop.controller)) troopsByCountry.set(troop.controller, { levy: 0, regular: 0, mercenary: 0 });
      const bucket = troopsByCountry.get(troop.controller);
      bucket[troop.category] = (bucket[troop.category] || 0) + troop.strength;
    }
    result.countries.forEach((c) => {
      const bucket = troopsByCountry.get(c.number);
      if (!bucket) return;
      c.armyLeviesK = bucket.levy;
      c.armyRegularsK = bucket.regular;
      c.armyMercenariesK = bucket.mercenary;
      c.armyTotalK = bucket.levy + bucket.regular + bucket.mercenary;
    });
    computeCountryLocationMetrics(result);
    renderOverview(result);
    renderPlayers(result);
    renderCountries(result);
    renderTrends(result);
    renderBlackDeath(result);

    // A new save means whatever ledger was loaded (if any) belonged to a
    // DIFFERENT save - clear it before the immediate render below so a
    // previous campaign's data can't flash under this save's name while
    // autoLinkLlamaForCurrentSave looks for the right one asynchronously.
    currentSaveDisplayName = displayName;
    llamaSnapshotsLedger = null;
    llamaEventsLedger = null;
    llamaAutoLinked = false;
    setLlamaLinkStatus(null);
    llamaAutoStatusEl.textContent = "Checking for this save's recorder data…";
    renderLlamaScore();
    autoLinkLlamaForCurrentSave().catch((err) => {
      llamaAutoStatusEl.textContent = `Could not auto-link recorder data: ${err.message}`;
      updateLlamaPanelVisibility();
    });

    if (tabPanels.map && !tabPanels.map.hidden) renderMap(result);

    // Loading a save back out of the local history (see save-library.js)
    // re-parses nothing and shouldn't bump its "uploaded" timestamp - only
    // a fresh parse (options.persist left at its default) gets saved.
    if (options.persist !== false && !staleParsedResult) saveResultToLibrary(displayName, result);

    // If the page loaded from a ?save=<id> link that wasn't in this
    // browser's history yet (see initFromShareUrl()), and the save that
    // just finished loading is the one the link was for, jump to the tab
    // the link pointed at instead of leaving the viewer on whatever tab
    // happened to be active already.
    if (pendingShareId && typeof SaveLibrary !== "undefined") {
      const thisId = SaveLibrary.deriveSaveId(result);
      pendingShareNoticeEl.hidden = true;
      if (thisId === pendingShareId) activateTab(pendingShareTab);
      pendingShareId = null;
    }

    updateShareUrl();
  }

  function visiblePlayers(result) {
    const excluded = getAllExcludedPlayers();
    return result.players.filter((p) => !excluded.has(p.name) && p.country);
  }

  function renderTrends(result) {
    if (typeof Charts === "undefined") return;
    const players = visiblePlayers(result);
    const withHistory = players.filter((p) => p.country.historicalPopulation && p.country.historicalPopulation.length);
    const popChartEl = document.getElementById("populationChart");
    const taxChartEl = document.getElementById("taxBaseChart");
    const taxPerPopChartEl = document.getElementById("taxBasePerPopChart");
    if (!withHistory.length) {
      popChartEl.innerHTML = '<div class="chart-title">No historical data available for current players.</div>';
      taxChartEl.innerHTML = "";
      if (taxPerPopChartEl) taxPerPopChartEl.innerHTML = "";
      return;
    }

    const dateStr = (result.metadata && result.metadata.date) || "";
    const currentYear = parseInt(dateStr, 10) || new Date().getFullYear();
    // Countries don't all have the same amount of history (a newly formed/
    // released nation has fewer entries than one that's existed since game
    // start), but the LAST entry in every array is always "now" - so align
    // series to a shared axis by right-anchoring (padding the front with
    // undefined) rather than assuming every array is the same length and
    // plotting them all starting at index 0 (which would misalign a shorter
    // series to the wrong years).
    const len = Math.max(...withHistory.map((p) => p.country.historicalPopulation.length));
    const years = Array.from({ length: len }, (_, i) => currentYear - (len - 1 - i));

    const series = withHistory.map((p) => ({
      label: `${p.name} (${p.country.tag})`,
      color: p.country.color || undefined,
    }));

    function alignRight(points) {
      const pad = len - points.length;
      return pad > 0 ? Array(pad).fill(undefined).concat(points) : points.slice(points.length - len);
    }

    function taxBasePerPopSeries(country) {
      const pop = alignRight(country.historicalPopulation || []);
      const tax = alignRight(country.historicalTaxBase || []);
      return tax.map((taxValue, i) => {
        const popValue = pop[i];
        return typeof taxValue === "number" && typeof popValue === "number" && popValue > 0 ? taxValue / popValue : undefined;
      });
    }

    renderChartWithRange(popChartEl, {
      title: "Population over time (people)",
      years,
      series: withHistory.map((p, i) => ({
        ...series[i],
        points: alignRight((p.country.historicalPopulation || []).map((v) => (typeof v === "number" ? v * 1000 : v))),
      })),
    });
    renderChartWithRange(taxChartEl, {
      title: "Tax base over time",
      years,
      series: withHistory.map((p, i) => ({ ...series[i], points: alignRight(p.country.historicalTaxBase || []) })),
    });
    if (taxPerPopChartEl) {
      renderChartWithRange(taxPerPopChartEl, {
        title: "Tax base / 1k people over time",
        years,
        yScale: "tight",
        series: withHistory.map((p, i) => ({ ...series[i], points: taxBasePerPopSeries(p.country) })),
      });
    }
  }

  // historicalPopulation is one entry per in-game year, ending at the
  // save's current year (see renderTrends above) - walking back from there
  // lets any specific year's population be read off without a separate
  // start-date field, the same trick renderTrends uses for its x-axis.
  function populationAtYear(country, year, currentYear) {
    const arr = country.historicalPopulation;
    if (!Array.isArray(arr) || !arr.length || !Number.isFinite(year) || !Number.isFinite(currentYear)) return undefined;
    const idx = arr.length - 1 - (currentYear - year);
    if (idx < 0 || idx >= arr.length) return undefined;
    const v = arr[idx];
    return typeof v === "number" ? v : undefined;
  }

  const BLACK_DEATH_COLUMNS = [
    {
      key: "tag",
      label: "Tag",
      render: (c) =>
        `${c.color ? `<span class="color-swatch" style="background:${escapeHtml(c.color)}"></span>` : ""}<span class="tag-badge">${escapeHtml(c.tag || "?")}</span>`,
    },
    { key: "playerNames", label: "Player(s)", render: (c) => escapeHtml((c.players || []).join(", ")) },
    { key: "popAtStart", label: "Population (start)", numeric: true, render: (c) => fmtPopulation(c.popAtStart) },
    { key: "deaths", label: "Black Death Deaths", numeric: true, render: (c) => (typeof c.deaths === "number" ? fmtPopulation(c.deaths) : "-") },
    {
      key: "popLossPct",
      label: "Lost %",
      numeric: true,
      heatColumn: true,
      lowerIsBetter: true,
      render: (c) => (typeof c.popLossPct === "number" ? `${(c.popLossPct * 100).toFixed(1)}%` : "-"),
    },
  ];

  // "Winner" is ambiguous here (least population lost vs. most) - left as a
  // sortable table (click "Lost %" to flip direction) rather than a single
  // hardcoded verdict.
  function renderBlackDeath(result) {
    const bd = result.blackDeath || {};
    if (!bd.start) {
      blackDeathSummaryEl.textContent = "The Black Death hasn't struck yet in this campaign.";
      blackDeathTableEl.innerHTML = "";
      return;
    }

    const currentYear = parseInt((result.metadata && result.metadata.date) || "", 10);
    const startYear = parseInt(bd.start, 10);
    const ongoing = !bd.end;

    blackDeathSummaryEl.textContent = ongoing
      ? `Black Death began ${bd.start} and is still ongoing as of ${result.metadata.date || "the save's date"} - showing deaths so far.`
      : `Black Death struck from ${bd.start} to ${bd.end}.`;

    // Deaths come from the game's own per-country disease death tally
    // (disease_outbreak_manager.data[].countries, attributed to whichever
    // country owned a location at the moment of each death), NOT a
    // population(start) vs. population(end) diff - that diff is polluted by
    // any land gained or lost during the outbreak window (conquest,
    // colonization, war losses), which has nothing to do with actual plague
    // deaths. See js/clausewitz.js's parseDiseaseOutbreakManagerSection.
    const deathsByCountry = bd.deathsByCountry || {};
    const visibleNames = new Set(visiblePlayers(result).map((p) => p.name));
    const rows = result.countries
      .filter((c) => c.countryType === "Real" && c.players && c.players.some((name) => visibleNames.has(name)))
      .map((c) => {
        const popAtStart = populationAtYear(c, startYear, currentYear);
        const deaths = typeof deathsByCountry[c.number] === "number" ? deathsByCountry[c.number] : undefined;
        const popLossPct = typeof deaths === "number" && popAtStart > 0 ? deaths / popAtStart : undefined;
        return { ...c, popAtStart, deaths, popLossPct };
      });

    // Ascending (lowest Lost % first) - the least-affected country is the
    // "winner" of the outbreak, per the tab's rename.
    renderSortableTable(blackDeathTableEl, rows, BLACK_DEATH_COLUMNS, { defaultSortKey: "popLossPct", defaultSortDir: 1, colorKeyMetrics: true });
  }

  // --- Llama score (js/llama-score.js) ---
  //
  // Per-war win/loss and player attribution are best-effort guesses (see
  // llama-score.js's module comment) - corrections are stored per-save
  // (war/country numbers are only meaningful within one save), mirroring
  // the excluded-players localStorage pattern above.
  const LLAMA_OVERRIDES_PREFIX = "eu5-analyzer-llama-overrides:";
  function getLlamaOverrides(saveId) {
    try {
      return JSON.parse(localStorage.getItem(LLAMA_OVERRIDES_PREFIX + saveId) || "{}");
    } catch (err) {
      return {};
    }
  }
  function setLlamaOverrides(saveId, overrides) {
    localStorage.setItem(LLAMA_OVERRIDES_PREFIX + saveId, JSON.stringify(overrides));
  }

  // Enemies/Allies count only PLAYER-controlled countries on each side for a
  // real PvP war (so an AI call-in tagging along doesn't dilute/inflate the
  // war-score formula) - but a non-PvP war (isPvP false, always excluded/
  // unscored) instead shows the war's real FULL participant count, AI
  // included, as reference data. Without this tooltip a large "Allies"
  // number on a solo-player's excluded row reads as a bug ("I had no player
  // allies") when it's actually accurate - just counting every co-belligerent
  // on that side, not just players, because the row isn't scored anyway.
  function renderEA(value, row) {
    const num = fmtNum(value, 0);
    if (row.isPvP) return num;
    return `<span title="This war had no player opponent, so it isn't scored - this counts every co-belligerent on this side (AI included), not just players.">${num}</span>`;
  }

  const AUTO_EXCLUDE_TITLES = {
    "vs-ai": "Auto-excluded: no country on the opposing side was ever recorded as player-controlled - a fight against AI isn't a PvP result, so it's kept visible but doesn't score. Uncheck to score it anyway.",
    "vs-player": "Auto-excluded: the opposing side had a real player in this war, so it isn't a PvE result and doesn't count under Alpaca Points. Uncheck to score it anyway.",
    "player-departed": "Auto-excluded: this player had already stopped controlling this country (recorder saw it revert to AI) before this war even began - a war they were actually playing when it started still counts, even if they later left partway through it. Uncheck to score it anyway.",
    "opponent-departed": "Auto-excluded: every enemy in this war had already left the campaign before this war even began (fighting an abandoned country doesn't score) - a war fought against a real opponent still counts even if they left partway through it. Uncheck to score it anyway.",
    "player-hidden": "Auto-excluded: this player was marked departed (Hide button here, or in the Llamabeg desktop dashboard) - wars that started before that point still count, only later ones are excluded. Unhide them to include everything again.",
    revolt: "Auto-excluded: this is a revolt (independence war or civil war) against your own rebels/pretender, not a fight against a foreign AI nation - it's shown for reference (and the winner is still tracked correctly) but never moves PVE/Alpaca Points either direction. Uncheck to score it anyway.",
    "no-battle-losses": "Auto-excluded: this country never recorded a Battle or Capture loss in this PvP war (attrition doesn't count) - joined but never actually fought, so it doesn't score and isn't counted as an enemy/ally for anyone else's score either. PvP-only (not applied to PvE, where a win engineered through your vassals doing the fighting should still count). Uncheck to score it anyway.",
  };
  function autoExcludeBadge(reason) {
    if (!reason || !AUTO_EXCLUDE_TITLES[reason]) return "";
    return ` <span class="llama-uncertain-badge" title="${escapeHtml(AUTO_EXCLUDE_TITLES[reason])}">auto</span>`;
  }

  // One <li> per player on a war's side, for the Player Wars (head-to-head)
  // table - LlamaScore.summarizeWars() groups computeLlamaScores'/
  // computeFromLedger's per-participant rows back into one entry per war,
  // but a side can still have more than one player (a coalition), so each
  // side is its own small list rather than a single cell value.
  // A PvE war's opposing side has no real player row (see summarizeWars'
  // aiSidePlaceholders in js/llama-score.js) - those entries carry
  // `isAiSide` + just a countryTag (already sorted biggest-nation-first, see
  // labelAndSortByLocationCount). Collapsed to ONE line - "leader (+N
  // allies)" - matching the style a real row's own allies get below, rather
  // than a separate tag per AI country (unreadable on a real 10+-country
  // coalition war). A real row's own `.A` (allies excluding self, already
  // vassal-filtered for PvE) is called out inline too, since "how many
  // allies" otherwise has nowhere to show for a PvE row (AI vassals
  // correctly have no row/tag of their own to display separately).
  function renderH2HSide(participants) {
    if (!participants.length) return '<span class="panel-note">-</span>';
    if (participants.every((r) => r.isAiSide)) {
      const [leader, ...rest] = participants;
      const alliesNote = rest.length > 0 ? ` <span class="panel-note">(+${rest.length} ${rest.length === 1 ? "ally" : "allies"})</span>` : "";
      return `<span class="tag-badge">${escapeHtml(leader.countryTag || "?")}</span>${alliesNote}`;
    }
    const items = participants.map((r) => {
      const name = `${escapeHtml(r.player || "-")} <span class="tag-badge">${escapeHtml(r.countryTag || "?")}</span>`;
      const alliesNote = r.A > 0 ? ` <span class="panel-note">(+${r.A} ${r.A === 1 ? "ally" : "allies"})</span>` : "";
      if (r.excluded) {
        return `<li>${name}${alliesNote} <span class="panel-note">(${escapeHtml(r.autoExcludeReason || "excluded")})</span></li>`;
      }
      if (typeof r.warScore !== "number") return `<li>${name}${alliesNote} <span class="panel-note">-</span></li>`;
      const cls = r.warScore > 0 ? "h2h-score-positive" : r.warScore < 0 ? "h2h-score-negative" : "h2h-score-neutral";
      const sign = r.warScore > 0 ? "+" : "";
      return `<li>${name}${alliesNote} <span class="${cls}">${sign}${fmtNum(r.warScore, 2)}</span></li>`;
    });
    return `<ul class="h2h-side">${items.join("")}</ul>`;
  }

  function renderH2HResult(war) {
    if (war.whitePeace) return '<span class="h2h-result-whitepeace">White Peace</span>';
    if (war.winnerSide === "Attacker") return '<span class="h2h-result-attacker">Attacker won</span>';
    if (war.winnerSide === "Defender") return '<span class="h2h-result-defender">Defender won</span>';
    return '<span class="panel-note">Unknown</span>';
  }

  // Maps js/llama-score.js's/llama-log-machine.js's internal `reason` codes
  // (see inferOutcome() in either file) to plain-English labels - lets the
  // user spot-check HOW a winner was decided, not just the verdict.
  const LLAMA_REASON_LABELS = {
    "post-war-reparations-enforced": "War reparations enforced (peace-treaty term)",
    "post-war-independence-granted": "Independence granted (peace-treaty term)",
    "post-war-revolt-crushed": "Rebellion fully crushed (annexed/reabsorbed)",
    "post-war-land-transfer": "Land changed hands (clean 1-on-1 data)",
    "post-war-land-transfer-coalition": "Land changed hands (coalition-wide - less certain)",
    "battle-losses-inflicted": "Battle losses (no economic signal)",
    "white-peace": "No decisive signal - treated as white peace",
    "war-disappeared-without-decisive-signal": "No signal before the war disappeared",
  };
  // Hover tooltips for the less-obvious reason codes - see the "How are
  // these scores calculated?" details block above for the full writeup.
  const LLAMA_REASON_TOOLTIPS = {
    "post-war-land-transfer-coalition":
      "Land changed hands, but only measured across the whole side (including any vassals/allies dragged in) rather than just the war's original two declared belligerents - a real signal, just less precise than a clean 1-on-1 comparison.",
  };
  // War score/prestige/battle-losses no longer decide a winner on their own
  // (see inferOutcome() in either file) - they're attached to every outcome
  // as contributingFactors so the reasoning stays auditable even though
  // only a land or gold exchange between the two principals can crown a
  // winner. Surfaced here as an extra tooltip line rather than a silent
  // internal-only field, per the user's "list them as contributing factors"
  // request.
  const CONTRIBUTING_FACTOR_LABELS = {
    "war-score": "war score",
    "battle-losses": "battle losses",
    "land-transfer": "land change",
    treasury: "treasury",
    prestige: "prestige",
    independence: "independence status",
  };
  function contributingFactorsNote(w) {
    const factors = w.contributingFactors || [];
    if (!factors.length) return "";
    const parts = factors.map((f) => `${CONTRIBUTING_FACTOR_LABELS[f.signal] || f.signal} leaned ${f.winnerSide}`);
    return `Considered but not decisive: ${parts.join("; ")}.`;
  }
  function renderLlamaReason(w) {
    const label = LLAMA_REASON_LABELS[w.reason] || w.reason || "Unknown";
    const tooltip = [LLAMA_REASON_TOOLTIPS[w.reason] || "", contributingFactorsNote(w)].filter(Boolean).join(" ");
    const cls = w.confidence === "high" ? "llama-confidence-high" : w.confidence === "medium" ? "llama-confidence-medium" : w.confidence === "low" ? "llama-confidence-low" : "";
    return `<span class="${cls}" title="${escapeHtml(tooltip)}">${escapeHtml(label)}</span>`;
  }

  const LLAMA_HEAD_TO_HEAD_COLUMNS = [
    { key: "startDate", label: "Started", render: (w) => escapeHtml(w.startDate || "-") },
    { key: "endDate", label: "Ended", render: (w) => escapeHtml(w.endDate || "-") },
    { key: "attackers", label: "Attacker(s)", render: (w) => renderH2HSide(w.attackers) },
    { key: "defenders", label: "Defender(s)", render: (w) => renderH2HSide(w.defenders) },
    { key: "result", label: "Result", render: renderH2HResult },
    { key: "reason", label: "How decided", render: renderLlamaReason },
  ];

  function renderLlamaHeadToHead(rows) {
    if (typeof LlamaScore === "undefined" || typeof LlamaScore.summarizeWars !== "function") return;
    const { wars, playerWhitePeaceCount, aiWhitePeaceCount } = LlamaScore.summarizeWars(rows, llamaScoreMode);
    const statsEl = document.getElementById("llamaWhitePeaceStats");
    if (statsEl) {
      statsEl.textContent =
        playerWhitePeaceCount || aiWhitePeaceCount
          ? `White peace count: ${playerWhitePeaceCount} player war(s), ${aiWhitePeaceCount} AI war(s) (neither counts toward score).`
          : "";
    }
    const tableEl = document.getElementById("llamaHeadToHeadTable");
    if (!tableEl) return;
    if (!wars.length) {
      tableEl.innerHTML = `<p class="panel-note">No ${llamaScoreMode === "pve" ? "PvE" : "player-vs-player"} wars found yet.</p>`;
      return;
    }
    renderSortableTable(tableEl, wars, LLAMA_HEAD_TO_HEAD_COLUMNS, { defaultSortKey: "endDate" });
  }

  const LLAMA_WAR_COLUMNS = [
    { key: "startDate", label: "Started", render: (r) => escapeHtml(r.startDate || "-") },
    { key: "endDate", label: "Ended", render: (r) => escapeHtml(r.active ? "In progress" : r.endDate || "-") },
    { key: "countryTag", label: "Country", render: (r) => `<span class="tag-badge">${escapeHtml(r.countryTag || "?")}</span>` },
    {
      key: "player",
      label: "Player",
      render: (r) =>
        r.ambiguous
          ? `<select class="llama-player-select" data-key="${escapeHtml(r.__key)}">${r.candidates
              .map((c) => `<option value="${escapeHtml(c)}" ${c === r.player ? "selected" : ""}>${escapeHtml(c)}</option>`)
              .join("")}</select>`
          : escapeHtml(r.player || "-"),
    },
    { key: "side", label: "Side", render: (r) => escapeHtml(r.side || "-") + (r.revolter ? " (revolter)" : "") },
    { key: "E", label: "Enemies", numeric: true, render: (r) => renderEA(r.E, r) },
    { key: "A", label: "Allies", numeric: true, render: (r) => renderEA(r.A, r) },
    {
      key: "win",
      label: "Win?",
      render: (r) =>
        r.active
          ? '<span class="panel-note">in progress</span>'
          : `<select class="llama-win-select" data-key="${escapeHtml(r.__key)}">
               <option value="" ${r.win === null ? "selected" : ""}>Unknown</option>
               <option value="win" ${r.win === true ? "selected" : ""}>Win</option>
               <option value="loss" ${r.win === false ? "selected" : ""}>Loss</option>
             </select>${r.uncertain ? ' <span class="llama-uncertain-badge" title="Best-effort guess from territory occupied at war\'s end - no clean win/loss field survives a concluded war">?</span>' : ""}`,
    },
    {
      key: "condottieri",
      label: "Condottieri",
      render: (r) =>
        r.active || r.E !== 0
          ? ""
          : `<input type="checkbox" class="llama-condottieri-check" data-key="${escapeHtml(r.__key)}" ${r.condottieri ? "checked" : ""}>`,
    },
    {
      key: "excluded",
      label: "Exclude",
      render: (r) =>
        r.active
          ? ""
          : `<input type="checkbox" class="llama-excluded-check" data-key="${escapeHtml(r.__key)}" ${r.excluded ? "checked" : ""}>` + autoExcludeBadge(r.autoExcludeReason),
    },
    { key: "warScore", label: "Score", numeric: true, render: (r) => (typeof r.warScore === "number" ? fmtNum(r.warScore, 2) : "-") },
  ];

  // Final ranking as one split (stacked) bar chart per player - each bar's
  // segments break Llama Points down into its GP Score baseline and its war
  // performance (wins/losses shown as separate positive/negative segments
  // rather than netted together), so the ranking itself and what's driving
  // it are both visible in a single chart instead of needing two side by
  // side (see Charts.renderStackedBarChart).
  function renderLlamaLeaderboardChart(leaderboardEl, leaderboard) {
    if (typeof Charts === "undefined") return;
    // A hidden/departed player's entry stays in the array now (see
    // computeFromLedger/computeLlamaScores - their earned/lost score is
    // preserved, not deleted), but this chart still shouldn't clutter the
    // default view with someone who's left - same default-hidden behavior
    // as before, just no longer at the cost of losing the number itself.
    const visible = leaderboard.filter((l) => !l.hidden);
    if (!visible.length) {
      leaderboardEl.innerHTML = '<p class="panel-note">No players found.</p>';
      return;
    }
    leaderboardEl.innerHTML = '<div id="llamaLeaderboardChart" class="trend-chart-wrap"></div>';
    // Ledger-mode leaderboards (js/llama-score.js's computeFromLedger) don't
    // carry a country color - the recorder's compact snapshot format doesn't
    // store it - but the save actually loaded in this browser tab (always
    // present, ledger mode or not) has the real thing, so fall back to
    // looking it up there by tag rather than leaving those bars uncolored.
    const tagToColor = new Map((latestResult && latestResult.countries ? latestResult.countries : []).filter((c) => c.tag && c.color).map((c) => [c.tag, c.color]));
    // PVE's points are relabeled "Alpaca Points" per the user's request -
    // same underlying computation/formula (llamaPoints field, unchanged) as
    // PVP's "Llama Points", just a different name so the two are never
    // confused for the same leaderboard at a glance.
    Charts.renderStackedBarChart(document.getElementById("llamaLeaderboardChart"), {
      title: llamaScoreMode === "pve" ? "Alpaca Points" : "Llama Points",
      items: visible.map((l) => ({
        label: `${l.player} (${l.countryTag || "?"})`,
        player: l.player,
        countryTag: l.countryTag,
        color: l.color || (l.countryTag ? tagToColor.get(l.countryTag) : null),
        total: Math.round((l.llamaPoints || 0) * 100) / 100,
        segments: [
          { label: "GP contribution", color: "#a9822f", value: Math.round(((l.gpScore || 0) / 100) * 100) / 100 },
          { label: "War contribution", color: "#1f7a3d", value: Math.round((l.vpPositive || 0) * 100) / 100 },
          { label: "Negative war score", color: "#a1442f", value: Math.round((l.vpNegative || 0) * 100) / 100 },
        ],
      })),
    });
  }

  function renderPerSaveLlamaScore(result) {
    const saveId = typeof SaveLibrary !== "undefined" ? SaveLibrary.deriveSaveId(result) : "unknown";
    let overrides = getLlamaOverrides(saveId);

    function setOverride(key, patch) {
      overrides[key] = Object.assign({}, overrides[key], patch);
      setLlamaOverrides(saveId, overrides);
    }

    function draw() {
      const { rows, leaderboard } = LlamaScore.computeLlamaScores(result, overrides, getExcludedPlayers(), llamaScoreMode);
      rows.forEach((r) => {
        r.__key = LlamaScore.overrideKey(r.warNumber, r.country);
      });

      renderLlamaLeaderboardChart(document.getElementById("llamaLeaderboard"), leaderboard);
      renderLlamaHeadToHead(rows);

      // Whichever category ISN'T the active mode is real data (kept for the
      // player-attribution candidate list etc.) but never scores here, so
      // it's just clutter in the corrections table by default - the "Show
      // AI-only wars"/"Show PvP wars" checkbox in the modal (see index.html's
      // #llamaWarModal) reveals it again.
      const visibleRows = llamaShowAiWarsEl.checked ? rows : rows.filter((r) => (llamaScoreMode === "pve" ? !r.isPvP : r.isPvP));
      renderSortableTable(document.getElementById("llamaWarsTable"), visibleRows, LLAMA_WAR_COLUMNS, {
        defaultSortKey: "startDate",
        onRender: (container) => {
          container.querySelectorAll(".llama-player-select").forEach((sel) => {
            sel.addEventListener("change", () => {
              setOverride(sel.dataset.key, { player: sel.value });
              draw();
            });
          });
          container.querySelectorAll(".llama-win-select").forEach((sel) => {
            sel.addEventListener("change", () => {
              setOverride(sel.dataset.key, { win: sel.value === "" ? undefined : sel.value === "win" });
              draw();
            });
          });
          container.querySelectorAll(".llama-condottieri-check").forEach((cb) => {
            cb.addEventListener("change", () => {
              setOverride(cb.dataset.key, { condottieri: cb.checked });
              draw();
            });
          });
          container.querySelectorAll(".llama-excluded-check").forEach((cb) => {
            cb.addEventListener("change", () => {
              setOverride(cb.dataset.key, { excluded: cb.checked });
              draw();
            });
          });
        },
      });
    }

    currentLlamaDraw = draw;
    draw();
  }

  // --- Llama score, campaign-ledger mode ---
  //
  // Alternative data source for the same panel: instead of scoring only the
  // wars visible in a single loaded save, read the recorder's running
  // snapshots.jsonl + war-events.jsonl ledger (see
  // llama-score-automatic-logging-machine/README.md) so wars that concluded
  // and were purged from war_manager between autosaves - which the per-save
  // view can never see, since there's no save left where they're still
  // present - still get scored via the recorder's last-known-state
  // inference (js/llama-score.js's computeFromLedger).
  const LLAMA_LEDGER_OVERRIDES_PREFIX = "eu5-analyzer-llama-ledger-overrides:";
  function getLlamaLedgerOverrides(campaignKey) {
    try {
      return JSON.parse(localStorage.getItem(LLAMA_LEDGER_OVERRIDES_PREFIX + campaignKey) || "{}");
    } catch (err) {
      return {};
    }
  }
  function setLlamaLedgerOverrides(campaignKey, overrides) {
    localStorage.setItem(LLAMA_LEDGER_OVERRIDES_PREFIX + campaignKey, JSON.stringify(overrides));
  }

  // Recorder output is JSON Lines - one object per line, and the file can be
  // large (tens of MB over a long campaign), so a bad/truncated line (e.g.
  // the recorder was killed mid-write) shouldn't take down the whole parse.
  function parseJsonl(text) {
    const records = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch (err) {
        // Skip a malformed line (e.g. truncated by a killed recorder process).
      }
    }
    return records;
  }

  // The recorder can accumulate snapshots from more than one campaign in the
  // same ledger - e.g. a `--all-campaigns` backfill, or just having pointed
  // it at different save folders over time (this project's own test-save
  // corpus does exactly that). computeFromLedger's country numbers, player-
  // to-country attribution, and "latest" snapshot are only meaningful within
  // ONE campaign - scoring the raw multi-campaign ledger silently merges
  // unrelated countries/players and produces nonsense (e.g. GP Score
  // collapsing to 0 for everyone because the "latest" snapshot picked isn't
  // even from the campaign being scored). So pick one campaign - the one
  // with the most recently *recorded* snapshot (wall-clock `capturedAt`;
  // in-game dates aren't comparable across unrelated campaigns) - and drop
  // everything else before handing data to LlamaScore.
  function pickLatestCampaignKey(snapshots) {
    let best = null;
    for (const s of snapshots) {
      if (!s || !s.campaignKey || !s.capturedAt) continue;
      if (!best || s.capturedAt > best.capturedAt) best = s;
    }
    return best ? best.campaignKey : null;
  }

  function filterLedgerToCampaign(snapshots, events, campaignKey) {
    const filteredSnapshots = snapshots.filter((s) => s && s.campaignKey === campaignKey);
    const sourceHashToCampaign = new Map();
    for (const s of snapshots) {
      if (s && s.sourceHash) sourceHashToCampaign.set(s.sourceHash, s.campaignKey);
    }
    const filteredEvents = events.filter((e) => e && sourceHashToCampaign.get(e.sourceHash) === campaignKey);
    return { snapshots: filteredSnapshots, events: filteredEvents };
  }

  async function sha256Hex(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function ledgerUploadIso(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function uniqueSorted(values) {
    return [...new Set(values.filter(Boolean).map(String))].sort((a, b) => a.localeCompare(b));
  }

  // Reshapes this browser's own in-memory ledger (already read straight off
  // the recorder's JSONL files, whether via the auto-connected folder or the
  // manual file pickers) into the same campaign/snapshot/event row shapes
  // scripts/import-llama-ledgers-to-supabase.js's loadCampaign() produces
  // server-side - kept in lockstep with that function deliberately, so a
  // "Share link" upload and a CLI `data:import` run land identical rows.
  // Only ever called on data this browser already trusts (its own recorder
  // output), so this is reshaping, not validating untrusted input.
  async function shapeCampaignLedgerForUpload(campaignKey, snapshots, events) {
    const shapedSnapshots = [];
    for (let i = 0; i < snapshots.length; i++) {
      const snapshot = snapshots[i];
      const lineNumber = i + 1;
      const sourceHash = snapshot.sourceHash || (await sha256Hex(`${campaignKey}:snapshot:${lineNumber}`));
      shapedSnapshots.push({
        campaign_key: snapshot.campaignKey || campaignKey,
        source_hash: sourceHash,
        line_number: lineNumber,
        captured_at: ledgerUploadIso(snapshot.capturedAt),
        source_file: snapshot.sourceFile || null,
        game_date: snapshot.date || null,
        game_year: Number.isFinite(snapshot.year) ? snapshot.year : null,
        playthrough_name: snapshot.playthroughName || null,
        game_version: snapshot.gameVersion || null,
        player_country_count: Array.isArray(snapshot.playerCountries) ? snapshot.playerCountries.length : 0,
        war_count: Array.isArray(snapshot.wars) ? snapshot.wars.length : 0,
        war_filter: snapshot.warFilter || null,
        snapshot,
      });
    }

    const shapedEvents = [];
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const lineNumber = i + 1;
      const sourceHash = event.sourceHash || null;
      const eventId = await sha256Hex(`${campaignKey}:event:${lineNumber}:${sourceHash || ""}:${event.type || ""}:${event.warNumber || ""}`);
      shapedEvents.push({
        event_id: eventId,
        campaign_key: campaignKey,
        source_hash: sourceHash,
        line_number: lineNumber,
        event_type: event.type || null,
        war_number: Number.isFinite(event.warNumber) ? event.warNumber : null,
        game_date: event.date || null,
        event,
      });
    }

    const latest =
      shapedSnapshots
        .filter((row) => row.captured_at)
        .slice()
        .sort((a, b) => a.captured_at.localeCompare(b.captured_at))
        .pop() || shapedSnapshots[shapedSnapshots.length - 1] || null;
    const latestPlayers = latest && Array.isArray(latest.snapshot.playerCountries) ? latest.snapshot.playerCountries : [];
    const playerNames = uniqueSorted(latestPlayers.flatMap((country) => (Array.isArray(country.players) ? country.players : [])));

    const campaign = {
      campaign_key: campaignKey,
      playthrough_name: latest ? latest.playthrough_name : null,
      game_version: latest ? latest.game_version : null,
      latest_game_date: latest ? latest.game_date : null,
      latest_game_year: latest ? latest.game_year : null,
      latest_captured_at: latest ? latest.captured_at : null,
      latest_source_hash: latest ? latest.source_hash : null,
      snapshot_count: shapedSnapshots.length,
      event_count: shapedEvents.length,
      player_names: playerNames,
      latest_players: latestPlayers,
    };

    return { campaign, snapshots: shapedSnapshots, events: shapedEvents };
  }

  const LLAMA_LEDGER_WAR_COLUMNS = [
    { key: "startDate", label: "Started", render: (r) => escapeHtml(r.startDate || "-") },
    { key: "endDate", label: "Ended", render: (r) => escapeHtml(r.endDate || "-") },
    { key: "countryTag", label: "Country", render: (r) => `<span class="tag-badge">${escapeHtml(r.countryTag || "?")}</span>` },
    {
      key: "player",
      label: "Player",
      render: (r) =>
        r.ambiguous
          ? `<select class="llama-ledger-player-select" data-key="${escapeHtml(r.__key)}">${r.candidates
              .map((c) => `<option value="${escapeHtml(c)}" ${c === r.player ? "selected" : ""}>${escapeHtml(c)}</option>`)
              .join("")}</select>`
          : escapeHtml(r.player || "-"),
    },
    { key: "side", label: "Side", render: (r) => escapeHtml(r.side || "-") },
    { key: "E", label: "Enemies", numeric: true, render: (r) => renderEA(r.E, r) },
    { key: "A", label: "Allies", numeric: true, render: (r) => renderEA(r.A, r) },
    {
      key: "win",
      label: "Win?",
      render: (r) =>
        `<select class="llama-ledger-win-select" data-key="${escapeHtml(r.__key)}">
           <option value="win" ${r.win === true ? "selected" : ""}>Win</option>
           <option value="loss" ${r.win === false ? "selected" : ""}>Loss</option>
           <option value="whitepeace" ${r.whitePeace ? "selected" : ""}>White Peace</option>
         </select>`,
    },
    {
      key: "reason",
      label: "Inferred from",
      render: (r) => `${escapeHtml(r.reason || "unknown")} <span class="panel-note">(${escapeHtml(r.confidence || "unknown")} confidence)</span>`,
    },
    {
      key: "condottieri",
      label: "Condottieri",
      render: (r) => (r.E !== 0 ? "" : `<input type="checkbox" class="llama-ledger-condottieri-check" data-key="${escapeHtml(r.__key)}" ${r.condottieri ? "checked" : ""}>`),
    },
    {
      key: "excluded",
      label: "Exclude",
      render: (r) =>
        `<input type="checkbox" class="llama-ledger-excluded-check" data-key="${escapeHtml(r.__key)}" ${r.excluded ? "checked" : ""}>` + autoExcludeBadge(r.autoExcludeReason),
    },
    { key: "warScore", label: "Score", numeric: true, render: (r) => (typeof r.warScore === "number" ? fmtNum(r.warScore, 2) : "-") },
  ];

  function renderLedgerLlamaScore() {
    const distinctCampaigns = new Set(llamaSnapshotsLedger.filter((s) => s && s.campaignKey).map((s) => s.campaignKey));
    const campaignKey = pickLatestCampaignKey(llamaSnapshotsLedger) || "campaign";
    const { snapshots, events } = filterLedgerToCampaign(llamaSnapshotsLedger, llamaEventsLedger, campaignKey);
    let overrides = getLlamaLedgerOverrides(campaignKey);

    function setOverride(key, patch) {
      overrides[key] = Object.assign({}, overrides[key], patch);
      setLlamaLedgerOverrides(campaignKey, overrides);
    }

    function draw() {
      const { rows, leaderboard, latestSnapshot, unscoreableCount } = LlamaScore.computeFromLedger(
        snapshots,
        events,
        overrides,
        excludedPlayersForScoring(),
        llamaScoreMode
      );
      rows.forEach((r) => {
        r.__key = LlamaScore.overrideKey(r.warNumber, r.country);
      });

      const scoredCount = rows.filter((r) => !r.excluded).length;
      llamaLedgerStatusEl.textContent =
        `Loaded ${llamaSnapshotsLedger.length.toLocaleString()} snapshot(s) and ${llamaEventsLedger.length.toLocaleString()} event(s)` +
        (distinctCampaigns.size > 1 ? ` spanning ${distinctCampaigns.size} campaigns - showing the most recently recorded one` : "") +
        (latestSnapshot ? `: ${latestSnapshot.playthroughName || "campaign"} at ${latestSnapshot.date || "?"}.` : ".") +
        ` ${scoredCount.toLocaleString()} scored ${llamaScoreMode === "pve" ? "PvE" : "player"} war(s) found.` +
        (unscoreableCount
          ? ` (${unscoreableCount.toLocaleString()} more war(s) disappeared with no recorded state to score them from - ` +
            `likely logged before a recorder restart could recover them; re-running the recorder while the original saves still exist will fix this going forward.)`
          : "");

      renderLlamaLeaderboardChart(document.getElementById("llamaLeaderboard"), leaderboard);
      renderLlamaHeadToHead(rows);

      // Whichever category ISN'T the active mode is real data but never
      // scores - hidden from the corrections table by default (see the
      // identical filter in renderPerSaveLlamaScore above), revealed via the
      // modal's checkbox.
      const visibleRows = llamaShowAiWarsEl.checked ? rows : rows.filter((r) => (llamaScoreMode === "pve" ? !r.isPvP : r.isPvP));
      renderSortableTable(document.getElementById("llamaWarsTable"), visibleRows, LLAMA_LEDGER_WAR_COLUMNS, {
        defaultSortKey: "endDate",
        onRender: (container) => {
          container.querySelectorAll(".llama-ledger-player-select").forEach((sel) => {
            sel.addEventListener("change", () => {
              setOverride(sel.dataset.key, { player: sel.value });
              draw();
            });
          });
          container.querySelectorAll(".llama-ledger-win-select").forEach((sel) => {
            sel.addEventListener("change", () => {
              // "whitepeace" is stored as that literal string, not a
              // boolean - see js/llama-score.js's override.win handling -
              // null would be indistinguishable from "no override set".
              setOverride(sel.dataset.key, { win: sel.value === "whitepeace" ? "whitepeace" : sel.value === "win" });
              draw();
            });
          });
          container.querySelectorAll(".llama-ledger-condottieri-check").forEach((cb) => {
            cb.addEventListener("change", () => {
              setOverride(cb.dataset.key, { condottieri: cb.checked });
              draw();
            });
          });
          container.querySelectorAll(".llama-ledger-excluded-check").forEach((cb) => {
            cb.addEventListener("change", () => {
              setOverride(cb.dataset.key, { excluded: cb.checked });
              draw();
            });
          });
        },
      });
    }

    currentLlamaDraw = draw;
    draw();
  }

  // Top-level router for the shared #llamaScorePanel: campaign-ledger mode
  // (both recorder files loaded) takes over the panel once available, since
  // it sees wars a single save structurally cannot (see the module comment
  // above renderLedgerLlamaScore); otherwise fall back to scoring whatever
  // save is currently loaded.
  function renderLlamaScore() {
    if (typeof LlamaScore === "undefined") return;
    const leaderboardEl = document.getElementById("llamaLeaderboard");
    const warsTableEl = document.getElementById("llamaWarsTable");
    if (llamaSnapshotsLedger && llamaEventsLedger) {
      // Ledger mode is meant to work standalone (connect the recorder's
      // folder, or load its files manually, without ever loading a save) -
      // updateLlamaPanelVisibility()/its caller is what actually reveals
      // the Llama Score tab in that case, this just renders into it.
      renderLedgerLlamaScore();
    } else if (latestResult) {
      llamaLedgerStatusEl.textContent = "No recorder ledger loaded yet - showing this save's own war data.";
      renderPerSaveLlamaScore(latestResult);
    } else {
      llamaLedgerStatusEl.textContent = "No recorder ledger loaded yet.";
      leaderboardEl.innerHTML = "";
      warsTableEl.innerHTML = "";
      currentLlamaDraw = null;
    }
  }

  // The checkbox defaults to ON (per user request) - the tab is visible up
  // front rather than waiting for auto-linked ledger data to appear before
  // showing itself. Explicitly unchecking it is remembered (see the "0"
  // fallback below), same as an explicit check always was.
  function updateLlamaPanelVisibility() {
    const shouldShow = llamaAutoLinked || llamaShowToggleEl.checked;
    const wasHidden = llamaTabBtn.hidden;
    llamaTabBtn.hidden = !shouldShow;
    if (!shouldShow && currentTab === "llama") activateTab(latestResult ? "metrics" : "load");
    // Ledger mode works standalone (connect the recorder folder without
    // ever loading a save) - if that's what just happened, jump straight to
    // the newly-available tab instead of leaving the user stranded on the
    // Load Save screen with no visible sign anything changed.
    else if (shouldShow && wasHidden && currentTab === "load") activateTab("llama");
  }

  // One visible place the user can watch the connection actually happen -
  // a green "Linked!" badge next to the Connect/Disconnect buttons (only
  // seen if "Manual setup" is open) AND a short mirror of the same message
  // next to the always-visible "Show Llama Score" checkbox, so linking is
  // confirmed even with the details collapsed. Pass null/"" to clear both.
  function setLlamaLinkStatus(message) {
    if (message) {
      llamaLinkStatusEl.textContent = "✅ " + message;
      llamaLinkStatusEl.hidden = false;
      llamaAutoStatusEl.textContent = "✅ " + message;
    } else {
      llamaLinkStatusEl.hidden = true;
      llamaLinkStatusEl.textContent = "";
      llamaAutoStatusEl.textContent = "";
    }
  }

  llamaShowToggleEl.addEventListener("change", () => {
    localStorage.setItem(LLAMA_SHOW_TOGGLE_KEY, llamaShowToggleEl.checked ? "1" : "0");
    updateLlamaPanelVisibility();
    if (!llamaTabBtn.hidden) renderLlamaScore();
  });
  llamaShowToggleEl.checked = localStorage.getItem(LLAMA_SHOW_TOGGLE_KEY) !== "0";

  // A compacted (older, no-longer-actively-recorded) campaign's ledger is
  // gzip-compressed on disk (see llama-log-machine.js's
  // compactCampaignLedger) - the automatic "Connect campaign folder..." flow
  // handles this transparently (js/ledger-connect.js), but this manual
  // file-picker fallback needs its own check since <input type=file> hands
  // back whatever raw bytes the user selected.
  function readLedgerFileText(file) {
    if (!/\.gz$/i.test(file.name)) return file.text();
    return new Response(file.stream().pipeThrough(new DecompressionStream("gzip"))).text();
  }

  function loadLlamaLedgerFile(file, kind) {
    readLedgerFileText(file).then((text) => {
      const records = parseJsonl(text);
      if (kind === "snapshots") llamaSnapshotsLedger = records;
      else llamaEventsLedger = records;
      llamaAutoLinked = true;
      if (llamaSnapshotsLedger && llamaEventsLedger) setLlamaLinkStatus("Linked! (manually loaded files)");
      updateLlamaPanelVisibility();
      renderLlamaScore();
    }).catch((err) => {
      llamaLedgerStatusEl.textContent = `Could not read ${file.name}: ${err.message}`;
    });
  }

  llamaSnapshotsInput.addEventListener("change", () => {
    if (llamaSnapshotsInput.files[0]) loadLlamaLedgerFile(llamaSnapshotsInput.files[0], "snapshots");
  });
  llamaEventsInput.addEventListener("change", () => {
    if (llamaEventsInput.files[0]) loadLlamaLedgerFile(llamaEventsInput.files[0], "events");
  });

  llamaWarDetailsBtn.addEventListener("click", () => llamaWarModalEl.showModal());
  llamaWarModalCloseBtn.addEventListener("click", () => llamaWarModalEl.close());
  llamaWarModalEl.addEventListener("click", (e) => {
    if (e.target === llamaWarModalEl) llamaWarModalEl.close(); // backdrop click (see #llamaWarModal::backdrop in style.css)
  });
  llamaShowAiWarsEl.addEventListener("change", () => {
    if (currentLlamaDraw) currentLlamaDraw();
  });

  const LLAMA_MODE_COPY = {
    pvp: {
      note: "Scoring player-vs-player wars - who beat whom, and the score exchanged.",
      h2hHeading: "Player Wars",
      h2hNote: "One row per war between players - who fought whom, who won, and how much score each side gained or lost.",
      aiToggleLabel: "Show AI-only wars (reference data, never scored)",
    },
    pve: {
      note: "Scoring wars against AI - how each player has done fighting the computer, using the same formula as PVP.",
      h2hHeading: "Wars vs AI",
      h2hNote: "One row per war a player fought against AI - started/ended, who won, and the score it was worth.",
      aiToggleLabel: "Show PvP wars (reference data, not scored here)",
    },
  };
  function applyLlamaModeCopy() {
    const copy = LLAMA_MODE_COPY[llamaScoreMode];
    llamaModeNoteEl.textContent = copy.note;
    llamaH2HHeadingEl.textContent = copy.h2hHeading;
    llamaH2HNoteEl.textContent = copy.h2hNote;
    llamaShowAiWarsLabelEl.textContent = copy.aiToggleLabel;
    llamaModePvpBtn.classList.toggle("active", llamaScoreMode === "pvp");
    llamaModePveBtn.classList.toggle("active", llamaScoreMode === "pve");
  }
  function setLlamaMode(mode) {
    if (mode === llamaScoreMode) return;
    llamaScoreMode = mode;
    localStorage.setItem(LLAMA_MODE_KEY, mode);
    applyLlamaModeCopy();
    if (currentLlamaDraw) currentLlamaDraw();
  }
  llamaModePvpBtn.addEventListener("click", () => setLlamaMode("pvp"));
  llamaModePveBtn.addEventListener("click", () => setLlamaMode("pve"));
  applyLlamaModeCopy();

  // --- Llama score, auto-connected campaign folder (js/ledger-connect.js) ---
  //
  // The File System Access API is Chromium-only, so this whole block is a
  // progressive enhancement over the manual file inputs above, not a
  // replacement for them - LedgerConnect.supported gates everything here,
  // and the manual inputs stay usable (and stay the only option) on
  // Firefox/Safari or if the user declines the folder prompt.
  function stopLedgerPolling() {
    if (ledgerPollTimer) clearInterval(ledgerPollTimer);
    ledgerPollTimer = null;
  }

  // Re-checks every 20s for new lines appended to the CURRENTLY LINKED
  // campaign (the recorder polls the save folder every 15s by default - see
  // llama-log-machine.js's DEFAULT_CONFIG) - compares lastModified first so
  // an unchanged ledger doesn't trigger a pointless reparse/re-render. This
  // deliberately keeps watching the same campaign rather than following
  // whichever is newest (like the old design did) - once a save's specific
  // campaign is linked (see autoLinkLlamaForCurrentSave), a NEW game started
  // elsewhere shouldn't silently swap the panel to a different campaign's
  // data out from under whatever save is actually loaded right now.
  function startLedgerPolling() {
    stopLedgerPolling();
    ledgerPollTimer = setInterval(async () => {
      if (!ledgerConnection || !ledgerConnection.campaignKey) return;
      try {
        const best = await LedgerConnect.findCampaignByKey(ledgerConnection.dataDirHandle, ledgerConnection.campaignKey);
        if (!best || best.lastModified <= (ledgerConnection.lastModified || 0)) return;
        await loadCampaignLedger(ledgerConnection.dataDirHandle, best);
        renderLlamaScore();
        // New snapshot data just landed - if it now shows a player departed
        // (see getAllExcludedPlayers), the Players table/Trends/Map should
        // reflect that live, without the user needing to reload the save or
        // click anything.
        if (latestResult) {
          drawPlayerTable(latestResult);
          renderTrends(latestResult);
          refreshMapForExclusions();
        }
      } catch (err) {
        // Transient read errors (e.g. the recorder mid-write) shouldn't kill polling.
      }
    }, 20000);
  }

  async function loadCampaignLedger(dataDirHandle, best) {
    const ledger = await LedgerConnect.readCampaignLedger(best.dirHandle);
    llamaSnapshotsLedger = ledger.snapshots;
    llamaEventsLedger = ledger.events;
    ledgerConnection = { dataDirHandle, campaignKey: best.campaignKey, lastModified: ledger.lastModified };
    sharedHiddenPlayers = await LedgerConnect.readHiddenPlayers(best.dirHandle).catch(() => new Map());
  }

  // autosave_<uuid>(.eu5 / _1.eu5 / _2.eu5 / ...) - same pattern
  // llama-log-machine.js's campaignKeyFromFile() uses to name
  // data/campaigns/<uuid>/, so a save's own filename is enough to find its
  // matching recorder output with no manual file picking at all.
  function campaignKeyFromFilename(name) {
    const m = String(name || "").match(/^autosave_(.+?)(?:_\d+)?\.eu5$/i);
    return m ? m[1] : null;
  }

  async function connectToDataDir(dataDirHandle) {
    const preferredKey = campaignKeyFromFilename(currentSaveDisplayName);
    const best = (preferredKey && (await LedgerConnect.findCampaignByKey(dataDirHandle, preferredKey))) || (await LedgerConnect.findLatestCampaign(dataDirHandle));
    if (!best) {
      llamaLedgerStatusEl.textContent = "Connected, but no campaigns/ folder with recorded data was found yet.";
      return;
    }
    await loadCampaignLedger(dataDirHandle, best);
    llamaConnectBtn.hidden = true;
    llamaDisconnectBtn.hidden = false;
    llamaManualLoaderEl.hidden = true;
    llamaAutoLinked = true;
    setLlamaLinkStatus(`Linked to campaign ${best.campaignKey}`);
    updateLlamaPanelVisibility();
    renderLlamaScore();
    startLedgerPolling();
    // Ledger data (and any departed players it reveals) is now available -
    // reflect it on the Players table/Trends/Map immediately rather than
    // waiting for the next poll or a manual Hide click.
    if (latestResult) {
      drawPlayerTable(latestResult);
      renderTrends(latestResult);
      refreshMapForExclusions();
    }
  }

  // Fallback for whenever the local recorder folder isn't available in THIS
  // browser (a ?save= link opened by someone who never ran the Dashboard,
  // or this browser just hasn't connected one) - fetches a static snapshot
  // of the same campaign's ledger from Supabase instead, keyed by the
  // save's own playthrough_id (from parsed metadata, not the filename - a
  // shared/renamed file still carries its real playthrough_id internally).
  // Only ever consulted AFTER every local lookup path has already failed
  // (see call sites below), so a live local folder always wins when one is
  // connected. Returns true if it found and loaded something.
  async function tryRemoteCampaignLedger() {
    if (typeof ShareStore === "undefined" || !ShareStore.fetchCampaignLedger) return false;
    const playthroughId = latestResult && latestResult.metadata && latestResult.metadata.playthrough_id;
    if (!playthroughId) return false;
    const ledger = await ShareStore.fetchCampaignLedger(String(playthroughId)).catch(() => null);
    if (!ledger || !ledger.snapshots.length) return false;
    llamaSnapshotsLedger = ledger.snapshots;
    llamaEventsLedger = ledger.events;
    stopLedgerPolling(); // static snapshot, not a live local folder - nothing to poll
    llamaConnectBtn.hidden = false; // still offer connecting a local folder for live updates
    llamaConnectBtn.textContent = "Connect campaign folder…";
    llamaConnectBtn.dataset.pending = "";
    llamaDisconnectBtn.hidden = true;
    llamaManualLoaderEl.hidden = true;
    llamaAutoLinked = true;
    setLlamaLinkStatus(`Loaded shared campaign ledger from the cloud (${ledger.snapshots.length} snapshot(s)) - connect a local recorder folder for live updates.`);
    updateLlamaPanelVisibility();
    renderLlamaScore();
    if (latestResult) {
      drawPlayerTable(latestResult);
      renderTrends(latestResult);
      refreshMapForExclusions();
    }
    return true;
  }

  // Runs after every save load (see onParsed) - finds and loads THIS save's
  // own campaign specifically (not just whichever is newest), with no
  // manual "Choose File" round trip once a data folder has been connected
  // once. Deliberately does NOT fall back to "latest campaign" the way the
  // manual Connect button does: showing a different campaign's data under a
  // save it doesn't belong to would be worse than showing nothing.
  async function autoLinkLlamaForCurrentSave() {
    llamaAutoLinked = false;
    llamaLinkStatusEl.hidden = true; // "Checking..." (set by the caller) stays in llamaAutoStatusEl until a real outcome replaces it below
    if (typeof LedgerConnect === "undefined" || !LedgerConnect.supported) {
      if (await tryRemoteCampaignLedger()) return;
      llamaAutoStatusEl.textContent = "Auto-linking needs a Chromium-based browser (Chrome/Edge) - use Manual setup below instead.";
      updateLlamaPanelVisibility();
      return;
    }
    const key = campaignKeyFromFilename(currentSaveDisplayName);
    if (!key) {
      if (await tryRemoteCampaignLedger()) return;
      llamaAutoStatusEl.textContent = "This save's filename doesn't look like a recorder-watched autosave - use Manual setup below to load its data.";
      updateLlamaPanelVisibility();
      return;
    }
    const handle = (ledgerConnection && ledgerConnection.dataDirHandle) || (await LedgerConnect.loadHandle());
    if (!handle) {
      if (await tryRemoteCampaignLedger()) return;
      llamaAutoStatusEl.textContent = "No recorder folder connected yet - see the Llama Score User Manual below.";
      updateLlamaPanelVisibility();
      return;
    }
    const granted = await LedgerConnect.verifyPermission(handle, false);
    if (!granted) {
      if (await tryRemoteCampaignLedger()) return;
      llamaAutoStatusEl.textContent = "Recorder folder was connected previously but needs re-granting - see Manual setup below.";
      llamaConnectBtn.hidden = false;
      llamaConnectBtn.textContent = "Reconnect campaign folder…";
      llamaConnectBtn.dataset.pending = "1";
      updateLlamaPanelVisibility();
      return;
    }
    const best = await LedgerConnect.findCampaignByKey(handle, key);
    if (!best) {
      if (await tryRemoteCampaignLedger()) return;
      llamaAutoStatusEl.textContent = `No recorder data found yet for this save's campaign (${key}).`;
      updateLlamaPanelVisibility();
      return;
    }
    await loadCampaignLedger(handle, best);
    llamaConnectBtn.hidden = true;
    llamaDisconnectBtn.hidden = false;
    llamaManualLoaderEl.hidden = true;
    llamaAutoLinked = true;
    setLlamaLinkStatus(`Linked to campaign ${best.campaignKey}`);
    updateLlamaPanelVisibility();
    renderLlamaScore();
    startLedgerPolling();
    // Same as connectToDataDir above - a departed player revealed by this
    // ledger data should disappear from the Players table/Trends/Map right
    // away, not just once something else happens to redraw them.
    if (latestResult) {
      drawPlayerTable(latestResult);
      renderTrends(latestResult);
      refreshMapForExclusions();
    }
  }

  async function tryAutoReconnect() {
    if (typeof LedgerConnect === "undefined" || !LedgerConnect.supported) return;
    llamaConnectBtn.hidden = false;
    const handle = await LedgerConnect.loadHandle();
    if (!handle) return;
    // queryPermission (no prompt) first - most browsers still re-prompt a
    // remembered handle once per session, so this usually just determines
    // whether "Reconnect" needs a click or can skip straight to loading.
    const granted = await LedgerConnect.verifyPermission(handle, false);
    if (granted) {
      ledgerConnection = { dataDirHandle: handle, campaignKey: null, lastModified: 0 };
      llamaConnectBtn.hidden = true;
      llamaDisconnectBtn.hidden = false;
      llamaManualLoaderEl.hidden = true;
      // Don't eagerly load "latest campaign" here - if a save loads shortly
      // after (the common case), autoLinkLlamaForCurrentSave will target
      // the RIGHT one. Only reach for a save already loaded before this
      // async permission check resolved (e.g. a ?save= share link).
      if (latestResult) {
        try {
          await autoLinkLlamaForCurrentSave();
        } catch (err) {
          llamaLedgerStatusEl.textContent = `Could not read the connected folder: ${err.message}`;
        }
      }
    } else {
      llamaConnectBtn.textContent = "Reconnect campaign folder…";
      llamaConnectBtn.dataset.pending = "1";
    }
  }

  llamaConnectBtn.addEventListener("click", async () => {
    try {
      let handle;
      if (llamaConnectBtn.dataset.pending === "1") {
        handle = await LedgerConnect.loadHandle();
        const granted = handle && (await LedgerConnect.verifyPermission(handle, true));
        if (!granted) {
          llamaLedgerStatusEl.textContent = "Permission to read the campaign folder wasn't granted.";
          return;
        }
      } else {
        handle = await window.showDirectoryPicker();
        await LedgerConnect.saveHandle(handle);
      }
      delete llamaConnectBtn.dataset.pending;
      llamaConnectBtn.textContent = "Connect campaign folder…";
      await connectToDataDir(handle);
    } catch (err) {
      if (err && err.name === "AbortError") return; // User closed the folder picker.
      llamaLedgerStatusEl.textContent = `Could not connect: ${err.message}`;
    }
  });

  llamaDisconnectBtn.addEventListener("click", async () => {
    stopLedgerPolling();
    ledgerConnection = null;
    llamaSnapshotsLedger = null;
    llamaEventsLedger = null;
    llamaAutoLinked = false;
    setLlamaLinkStatus(null);
    await LedgerConnect.clearHandle();
    llamaDisconnectBtn.hidden = true;
    llamaConnectBtn.hidden = false;
    llamaConnectBtn.textContent = "Connect campaign folder…";
    llamaManualLoaderEl.hidden = false;
    updateLlamaPanelVisibility();
    renderLlamaScore();
  });

  function renderChartWithRange(container, config) {
    const years = config.years || [];
    const max = Math.max(0, years.length - 1);
    container.innerHTML = `
      <div class="chart-range-controls">
        <label>Start <input type="range" class="chart-range-start" min="0" max="${max}" value="0"></label>
        <label>End <input type="range" class="chart-range-end" min="0" max="${max}" value="${max}"></label>
        <span class="chart-range-label"></span>
      </div>
      <div class="chart-range-inner"></div>
    `;
    const startInput = container.querySelector(".chart-range-start");
    const endInput = container.querySelector(".chart-range-end");
    const label = container.querySelector(".chart-range-label");
    const inner = container.querySelector(".chart-range-inner");

    function draw() {
      let start = parseInt(startInput.value, 10);
      let end = parseInt(endInput.value, 10);
      if (start > end) {
        const changedStart = document.activeElement === startInput;
        if (changedStart) end = start;
        else start = end;
        startInput.value = start;
        endInput.value = end;
      }
      label.textContent = years.length ? `${years[start]}-${years[end]}` : "";
      const slicedSeries = config.series.map((s) => ({ ...s, points: (s.points || []).slice(start, end + 1) }));
      let yMin;
      let yMax;
      if (config.yScale === "tight") {
        const values = slicedSeries.flatMap((s) => (s.points || []).filter((v) => typeof v === "number" && Number.isFinite(v)));
        if (values.length) {
          const sortedValues = values.slice().sort((a, b) => a - b);
          const at = (p) => sortedValues[Math.max(0, Math.min(sortedValues.length - 1, Math.round((sortedValues.length - 1) * p)))];
          const min = at(0.05);
          const max = at(0.95);
          const span = Math.max(max - min, Math.abs(max || min || 1) * 0.08, 0.001);
          yMin = min - span * 0.18;
          yMax = max + span * 0.18;
        }
      }
      Charts.renderLineChart(inner, {
        title: config.title,
        years: years.slice(start, end + 1),
        series: slicedSeries,
        yScale: config.yScale,
        yMin,
        yMax,
      });
    }

    startInput.addEventListener("input", draw);
    endInput.addEventListener("input", draw);
    draw();
  }

  // Hiding a player (the Players table's Hide button, or "Show" to clear the
  // whole list) needs to be reflected on the Map tab too - a departed
  // player's realm border/label/"Players" grouping should disappear from
  // the map exactly like it disappears from the Players table, not just
  // stop scoring. Always invalidates the cached render (mapRenderedForResult
  // = false) so the *next* Map tab visit rebuilds with the fresh excluded
  // set via activateTab()'s own existing guard, even if the user isn't on
  // the Map tab right now; if they already are, re-render immediately
  // instead of waiting for a tab switch that isn't coming. A fresh
  // createMapView() always resets pan/zoom - an accepted tradeoff for a
  // deliberate, infrequent action.
  function refreshMapForExclusions() {
    mapRenderedForResult = false;
    if (tabPanels.map && !tabPanels.map.hidden && latestResult) renderMap(latestResult);
  }

  function renderMap(result) {
    if (typeof MapView === "undefined") return;
    mapRenderedForResult = true;
    mapContainerEl.innerHTML = '<div class="map-loading">Loading map...</div>';
    MapView.createMapView(mapContainerEl, result, getAllExcludedPlayers()).catch((err) => {
      mapContainerEl.innerHTML =
        '<div class="map-loading">Map unavailable: ' +
        escapeHtml(err.message) +
        ". Make sure <code>map_data/</code> is set up (see README) - it's not bundled with the app.</div>";
    });
  }

  function fmtNum(n, digits) {
    if (n === undefined || n === null || Number.isNaN(n)) return "-";
    return Number(n).toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function fmtPercent(n, digits) {
    if (n === undefined || n === null || Number.isNaN(n)) return "-";
    return (Number(n) * 100).toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }) + "%";
  }

  function fmtPopulation(raw) {
    if (raw === undefined || raw === null || Number.isNaN(raw)) return "-";
    return Math.round(Number(raw) * 1000).toLocaleString();
  }

  // `countryType === "Real"` alone still includes every unformed/pre-spawn
  // country-database slot (formables, reserved native tags, etc.) that owns
  // zero locations - confirmed against real save data these are legitimate
  // placeholder entries (e.g. a "FIN" record sitting in the database years
  // before Finland actually forms, with historicalPopulation=[0] and no
  // economy block at all), not a parsing bug. They swamped the Countries
  // table with rows that are entirely "-" and inflated the Overview's
  // country count by nearly 3x in one real save (2501 "Real" entries, only
  // 1052 actually holding land). A landless "country" isn't a country
  // anyone cares to look at in either place, so both are scoped to ones
  // that actually exist on the map.
  function isRealTerritorialCountry(c) {
    return c.countryType === "Real" && typeof c.locationCount === "number" && c.locationCount > 0;
  }

  function renderOverview(result) {
    const meta = result.metadata || {};
    const realCountries = result.countries.filter(isRealTerritorialCountry);
    const totalGold = realCountries.reduce((sum, c) => sum + (c.gold || 0), 0);

    const stats = [
      ["Playthrough", meta.playthrough_name || "-"],
      ["Your Nation", meta.player_country_name || "-"],
      ["Date", meta.date || "-"],
      ["Game Version", meta.version || "-"],
      ["Countries", realCountries.length.toLocaleString()],
      ["Players", result.players.length.toLocaleString()],
      ["World Treasury (sum)", fmtNum(totalGold, 0)],
    ];

    overviewEl.innerHTML = stats
      .map(
        ([label, value]) =>
          `<div class="stat"><span class="label">${label}</span><span class="value">${escapeHtml(String(value))}</span></div>`
      )
      .join("");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function renderTableError(container, err) {
    if (window.console && console.error) console.error(err);
    const message = err && err.message ? err.message : String(err || "Unknown table error");
    container.innerHTML = `<p class="panel-note">Could not render this table: ${escapeHtml(message)}</p>`;
  }

  // Hover-only explanations for column headers, shown via the native title
  // attribute (see renderSortableTable's thead builder) - keyed by column
  // key, shared across every table so a key like "efficiency" only needs
  // writing once even though it appears in both the Countries and Players
  // tables. Only keys worth explaining are listed (self-explanatory ones
  // like "Treasury" or "Tag" are skipped) - a column with no entry here
  // just gets no tooltip, not a placeholder one.
  const COLUMN_DESCRIPTIONS = {
    scorePlace: "The game's own overall world rank for this country (score.score_place in the save) - lower is better, combines the ADM/DIP/MIL rank-in-category scores below.",
    admScore: "Administrative score rating (score.score_rating.ADM) - one of the game's three per-country competency scores; see the DIP/MIL tooltips for the other two.",
    dipScore: "Diplomatic score rating (score.score_rating.DIP) - one of the game's three per-country competency scores.",
    milScore: "Military score rating (score.score_rating.MIL) - one of the game's three per-country competency scores.",
    totalDevelopment: "Sum of the Development stat across every location this country owns.",
    avgDevelopment: "Total Development divided by number of owned locations - average development per location, independent of how large the country is.",
    lastMonthGoldIncome: "Gold income from last month (last_month_gold_income in the save) - the game's own single \"how much did I make\" figure.",
    income: "Gross income - all sources of income added together, before any expenses are subtracted.",
    expense: "Gross expense - all outgoing spending added together, before weighing it against income.",
    tradeIncome: "The Crown's actual state revenue from trade for the last completed month, read from the country's save-backed last_months_trade_income field. This already reflects the government's trade-income share; it does not sum the estates' separate private trade wealth. The live in-game Economy panel can differ because it previews the current month's routes.",
    taxIncome: "The Crown's actual state tax revenue for the last completed month, read from the country's save-backed last_months_tax_income field. It equals the sum of every estate's paid_taxes records. The live in-game Economy panel can differ because it recalculates the current month's estate tax projection after loading.",
    profit: "Income minus Expense - what's actually left over each month after paying for everything.",
    efficiency: "Profit divided by Income - the share of gross income kept as profit rather than spent. 100% = no expenses at all; 0% = spending exactly what you make; negative = spending more than you make.",
    lastMonthsArmyMaintenance: "Gold spent maintaining the standing army last month.",
    lastMonthsNavyMaintenance: "Gold spent maintaining the navy last month.",
    // Verified 2026-07-16 against the game's own Countries-tab ledger (a
    // "Sort by GDP" tooltip on that column) across all 15 rows of a real
    // save: raw gold-income / raw-population-field matched the game's
    // displayed figure to 3-4 significant digits every time (e.g. France
    // 825.46 / 10570 = 0.0781 vs the game's shown 0.0780) - this IS the
    // game's own GDP stat, just computed here rather than read from a saved
    // field (no literal "gdp" field exists anywhere in the save format).
    incomePerPop: "Last month's gold income divided by population - the game's own \"GDP\" figure (verified to match its Countries-tab ledger) - how much this country earns per person, independent of its total size.",
    taxBasePerPop: "Latest tax base value divided by population - how much taxable value this country generates per person.",
    latestTaxBase: "Base Tax - the country's current total tax base (from the last entry of its historical tax base, which is always \"now\"). The taxable value the crown draws its tax income from.",
    latestEconomicalBase: "Economic Base - the country's current total economic base (last entry of its historical economical base). A broader measure of the economy's size than tax base alone. Blank on older saves (pre-1.3), which don't record this.",
    manpowerPerPop: "Manpower divided by population - how much of this country's population is available as army reinforcements, per person.",
    greatPowerRank: "This country's rank on the game's Great Power standings (lower is better) - factors in population, income, advances, stability, prestige, markets, military, and more per the game's own Great Power Score.",
    popAtStart: "Population at the start of the Black Death outbreak, before any plague deaths.",
    deaths: "The game's own recorded death count for this country from this specific Black Death outbreak (disease_outbreak_manager's per-country tally) - not a population-before/after estimate, so land gained or lost during the outbreak doesn't distort it.",
    popLossPct: "Black Death deaths divided by population at the start of the outbreak - what share of this country's people the plague actually killed.",
    E: "Enemies - count of distinct enemy countries on the other side of this war (players only, for a scored PvP row).",
    A: "Allies - count of distinct allied countries on this player's own side of the war, not counting themselves.",
    warScore: "This war's contribution to the player's Llama/Alpaca Points, from the formula: 10·E·W/(A+1) + 10·(W−1)·(A+1)/(2·E) - bigger for beating more enemies with fewer allies helping.",
    navyShips: "Real ship count from subunit_manager (built warships only) - levy ships (conscripted fishing boats/birlinns) are excluded, since nobody counts those as real naval strength. Blank if this save has no naval subunit data to count from.",
    armyTotal: "Regiment COUNT from subunit_manager: Levies + Regulars + Mercenaries added together - one regiment counts the same whether it's full-strength or nearly wiped out. See the (k) columns for real troop headcounts. Blank if this save has no subunit data to count from.",
    armyLevies: "Feudal/tribal levy regiment COUNT, raised from estates (peasant levies, noble/tribal cavalry, etc.) - identified by carrying a levies block in the save, same signal used to separate levy ships from built ones in Navy Size.",
    armyRegulars: "Professionally built standing-army regiment COUNT - not raised from a levy, not a hired mercenary company.",
    armyMercenaries: "Hired mercenary company COUNT from the mercenary pool. Counted by whoever currently controls/employs them, not the save's own owner field for a mercenary unit - that field is always a constant placeholder, not the hiring country.",
    armyTotalK: "Real total troop headcount (thousands), not a bare regiment count - summed from each regiment's own current troop count (the save's per-regiment strength figure, e.g. a Byzantine cataphract regiment at 400 men), across Levies + Regulars + Mercenaries. Blank if this save has no subunit data.",
    armyLeviesK: "Real CURRENTLY-MUSTERED levy troop headcount (thousands) - summed per-regiment troop counts, restricted to levy regiments. Correctly 0 for a country at peace with no levies raised.",
    armyRegularsK: "Real regular troop headcount (thousands) - summed per-regiment troop counts, restricted to professionally-built regiments.",
    armyMercenariesK: "Real mercenary troop headcount (thousands) - summed per-regiment troop counts, restricted to hired mercenary companies.",
  };

  const COUNTRY_COLUMNS = [
    {
      key: "tag",
      label: "Tag",
      render: (c) =>
        `${c.color ? `<span class="color-swatch" style="background:${escapeHtml(c.color)}"></span>` : ""}<span class="tag-badge">${escapeHtml(c.tag || "?")}</span>`,
    },
    { key: "playerNames", label: "Player(s)", render: (c) => escapeHtml((c.players || []).join(", ")) },
    { key: "governmentType", label: "Government", render: (c) => escapeHtml(c.governmentType || "-") },
    { key: "scorePlace", label: "Rank", numeric: true, render: (c) => fmtNum(c.scorePlace, 0) },
    { key: "admScore", label: "ADM", numeric: true, render: (c) => fmtNum(c.admScore, 2) },
    { key: "dipScore", label: "DIP", numeric: true, render: (c) => fmtNum(c.dipScore, 2) },
    { key: "milScore", label: "MIL", numeric: true, render: (c) => fmtNum(c.milScore, 2) },
    { key: "locationCount", label: "Locations", numeric: true, render: (c) => fmtNum(c.locationCount, 0) },
    { key: "totalDevelopment", label: "Development", numeric: true, render: (c) => fmtNum(c.totalDevelopment, 1) },
    { key: "avgDevelopment", label: "Avg Dev/location", numeric: true, render: (c) => fmtNum(c.avgDevelopment, 2) },
    { key: "gold", label: "Treasury", numeric: true, render: (c) => fmtNum(c.gold, 1) },
    { key: "lastMonthGoldIncome", label: "Income/mo", numeric: true, render: (c) => fmtNum(c.lastMonthGoldIncome, 2) },
    { key: "income", label: "Gross Income", numeric: true, render: (c) => fmtNum(c.income, 1) },
    { key: "expense", label: "Gross Expense", numeric: true, render: (c) => fmtNum(c.expense, 1) },
    { key: "tradeIncome", label: "State Trade Income (Last Month)", numeric: true, render: (c) => fmtNum(c.tradeIncome, 2) },
    { key: "taxIncome", label: "State Tax Income (Last Month)", numeric: true, render: (c) => fmtNum(c.taxIncome, 2) },
    { key: "latestTaxBase", label: "Base Tax", numeric: true, render: (c) => fmtNum(c.latestTaxBase, 1) },
    { key: "latestEconomicalBase", label: "Economic Base", numeric: true, render: (c) => fmtNum(c.latestEconomicalBase, 1) },
    { key: "profit", label: "Profit", numeric: true, render: (c) => fmtNum(c.profit, 1) },
    {
      key: "efficiency",
      label: "Profit Efficiency",
      numeric: true,
      render: (c) => (typeof c.efficiency === "number" ? (c.efficiency * 100).toFixed(0) + "%" : "-"),
    },
    { key: "manpower", label: "Manpower (k)", numeric: true, render: (c) => fmtNum(c.manpower, 2) },
    { key: "lastMonthsArmyMaintenance", label: "Army Upkeep", numeric: true, render: (c) => fmtNum(c.lastMonthsArmyMaintenance, 2) },
    { key: "armyTotalK", label: "Active Army (k)", numeric: true, render: (c) => fmtNum(c.armyTotalK, 2) },
    { key: "armyTotal", label: "Active Regiments", numeric: true, render: (c) => fmtNum(c.armyTotal, 0) },
    { key: "armyLeviesK", label: "Levies (k)", numeric: true, render: (c) => fmtNum(c.armyLeviesK, 2) },
    { key: "armyLevies", label: "Levy Regiments", numeric: true, render: (c) => fmtNum(c.armyLevies, 0) },
    { key: "armyRegularsK", label: "Regulars (k)", numeric: true, render: (c) => fmtNum(c.armyRegularsK, 2) },
    { key: "armyRegulars", label: "Regular Regiments", numeric: true, render: (c) => fmtNum(c.armyRegulars, 0) },
    { key: "armyMercenariesK", label: "Mercenaries (k)", numeric: true, render: (c) => fmtNum(c.armyMercenariesK, 2) },
    { key: "armyMercenaries", label: "Merc. Regiments", numeric: true, render: (c) => fmtNum(c.armyMercenaries, 0) },
    { key: "population", label: "Population (people)", numeric: true, render: (c) => fmtPopulation(c.population) },
    { key: "incomePerPop", label: "GDP (Income/1k people)", numeric: true, render: (c) => fmtNum(c.incomePerPop, 3) },
    { key: "taxBasePerPop", label: "Tax Base/1k people", numeric: true, render: (c) => fmtNum(c.taxBasePerPop, 3) },
    { key: "manpowerPerPop", label: "Manpower/1k people", numeric: true, render: (c) => fmtNum(c.manpowerPerPop, 3) },
    { key: "stability", label: "Stability", numeric: true, render: (c) => fmtNum(c.stability, 1) },
    { key: "prestige", label: "Prestige", numeric: true, render: (c) => fmtNum(c.prestige, 1) },
    { key: "greatPowerRank", label: "GP Rank", numeric: true, render: (c) => fmtNum(c.greatPowerRank, 0) },
    { key: "lastMonthsNavyMaintenance", label: "Navy Upkeep", numeric: true, render: (c) => fmtNum(c.lastMonthsNavyMaintenance, 2) },
    { key: "sailors", label: "Sailors (k)", numeric: true, render: (c) => fmtNum(c.sailors, 2) },
    { key: "navyShips", label: "Navy Size", numeric: true, render: (c) => fmtNum(c.navyShips, 0) },
  ];

  // EU5 has no `slaves_estate` - `slaves` is only a pop TYPE (see
  // pop_types/00_default.txt), and its pops fall under dhimmi_estate or
  // peasants_estate depending on the country, never a distinct estate of
  // their own. A "Slaves" entry here previously always rendered as an
  // all-zero tab (no save data ever carries an estate_tax/taxRates key
  // named "slaves") - that population's tax is already counted correctly
  // under Commoners/Dhimmi above.
  const BASE_ESTATE_TAX_GROUPS = [
    { key: "commoners", label: "Commoners" },
    { key: "burghers", label: "Burghers" },
    { key: "clergy", label: "Clergy" },
    { key: "nobles", label: "Nobles" },
    { key: "tribesmen", label: "Tribesmen" },
    { key: "dhimmi", label: "Dhimmi" },
    { key: "cossacks", label: "Cossacks" },
  ];
  let activeEstateTaxGroups = BASE_ESTATE_TAX_GROUPS.slice();

  function estateMetricGroup(name) {
    const base = String(name || "").replace(/_estate$/, "");
    if (base === "peasants" || base === "commoners" || base === "common" || base === "laborers" || base === "soldiers") return "commoners";
    if (base === "nobility") return "nobles";
    if (base === "tribes") return "tribesmen";
    return base;
  }

  function estateTaxMetricGroup(name) {
    const base = String(name || "").replace(/_estate$/, "");
    if (base === "soldiers") return "commoners";
    return estateMetricGroup(base);
  }

  function estateMetricLabel(key) {
    const known = BASE_ESTATE_TAX_GROUPS.find((group) => group.key === key);
    if (known) return known.label;
    return String(key || "")
      .replace(/_estate$/, "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function estateShareKey(key) {
    return `${key}PopShare`;
  }

  const WIKI_FILE_BASE = "https://eu5.paradoxwikis.com/Special:Redirect/file/";
  function wikiIcon(name) {
    return WIKI_FILE_BASE + encodeURIComponent(name);
  }

  function estateIcon(groupKey) {
    const icons = {
      commoners: "Estate peasants.png",
      peasants: "Estate peasants.png",
      burghers: "Estate burghers.png",
      clergy: "Estate clergy.png",
      nobles: "Estate nobles.png",
      tribesmen: "Estate tribes.png",
      tribes: "Estate tribes.png",
      dhimmi: "Estate dhimmi.png",
      cossacks: "Estate cossacks.png",
      crown: "Estate crown.png",
    };
    return icons[groupKey] ? wikiIcon(icons[groupKey]) : wikiIcon("Estates.png");
  }

  function estateTaxPer1kKey(key) {
    return `${key}TaxPer1k`;
  }

  function estateTaxBaseTotalKey(key) {
    return `${key}TaxBaseTotal`;
  }

  function estateTaxRateKey(key) {
    return `${key}TaxRate`;
  }

  function estateExtractedTaxTotalKey(key) {
    return `${key}ExtractedTaxTotal`;
  }

  function estateExtractedTaxPer1kKey(key) {
    return `${key}ExtractedTaxPer1k`;
  }

  function estatePrivateTradeIncomeKey(key) {
    return `${key}PrivateTradeIncome`;
  }

  function estateMetricValue(row, key) {
    return row && typeof row[key] === "number" ? row[key] : undefined;
  }

  function populationRecordMap(result) {
    const map = new Map();
    for (const pop of result && result.popRecords ? result.popRecords : []) {
      if (!pop || typeof pop.number !== "number" || typeof pop.size !== "number") continue;
      map.set(pop.number, pop);
    }
    return map;
  }

  function appendColumns(target, columns) {
    columns.forEach((column) => target.push(column));
  }

  function estateTaxColumnTitle(group) {
    return `${group.label} tax base per 1k ${group.label.toLowerCase()} population. This is the save's estate-attributed tax base, not an estate tax policy toggle.`;
  }

  function estateExtractedTaxColumnTitle(group) {
    return `${group.label} extracted tax per 1k ${group.label.toLowerCase()} population, computed as estate-attributed tax base per 1k multiplied by this country's ${group.label.toLowerCase()} tax rate.`;
  }

  function estateTaxRateColumnTitle(group) {
    return `${group.label} tax rate from the country's economy.tax_rates save data.`;
  }

  function hasEstateTaxRateColumn(group) {
    return true;
  }

  function estateColumnsForGroup(group, renderValue, rows) {
    if (!group) return [];
    return [
      {
        key: estateShareKey(group.key),
        label: `${group.label} %`,
        title: `${group.label} share of population in the estate/taxation breakdown`,
        numeric: true,
        heatColumn: true,
        render: (row) => fmtPercent(renderValue(row, estateShareKey(group.key)), 1),
      },
      {
        key: estateTaxBaseTotalKey(group.key),
        label: "Base Tax",
        title: `${group.label} total estate-attributed tax base.`,
        numeric: true,
        heatColumn: true,
        render: (row) => fmtNum(renderValue(row, estateTaxBaseTotalKey(group.key)), 3),
      },
      {
        key: estateTaxPer1kKey(group.key),
        label: "Base Tax/1k",
        title: estateTaxColumnTitle(group),
        numeric: true,
        heatColumn: true,
        render: (row) => fmtNum(renderValue(row, estateTaxPer1kKey(group.key)), 4),
      },
      {
        key: estateTaxRateKey(group.key),
        label: "Rate",
        title: estateTaxRateColumnTitle(group),
        numeric: true,
        heatColumn: true,
        render: (row) => fmtPercent(renderValue(row, estateTaxRateKey(group.key)), 1),
      },
      {
        key: estateExtractedTaxTotalKey(group.key),
        label: "Income Tax",
        title: `${group.label} total extracted tax, computed as estate-attributed tax base multiplied by this country's ${group.label.toLowerCase()} tax rate.`,
        numeric: true,
        heatColumn: true,
        render: (row) => fmtNum(renderValue(row, estateExtractedTaxTotalKey(group.key)), 3),
      },
      {
        key: estateExtractedTaxPer1kKey(group.key),
        label: "Income Tax/1k",
        title: estateExtractedTaxColumnTitle(group),
        numeric: true,
        heatColumn: true,
        render: (row) => fmtNum(renderValue(row, estateExtractedTaxPer1kKey(group.key)), 4),
      },
      {
        key: estatePrivateTradeIncomeKey(group.key),
        label: "Private Trade Income (Last Month)",
        title: `${group.label} private trade income for the last completed month, read from this estate's own last_month.trade_income record. This belongs to the estate's separate private economy; it is not the Crown's State Trade Income.`,
        numeric: true,
        heatColumn: true,
        render: (row) => fmtNum(renderValue(row, estatePrivateTradeIncomeKey(group.key)), 2),
      },
    ];
  }

  function selectedEstateMetricGroup() {
    if (!activeEstateTaxGroups.length) return null;
    return activeEstateTaxGroups.find((group) => group.key === currentEstateMetricGroup) || activeEstateTaxGroups[0];
  }

  function estateCountryColumns(rows) {
    const columns = [];
    appendColumns(columns, estateColumnsForGroup(selectedEstateMetricGroup(), estateMetricValue, rows));
    return columns;
  }

  const PLAYER_COLUMNS = [
    { key: "name", label: "Player", render: (p) => escapeHtml(p.name || "-") },
    { key: "tag", label: "Tag", render: (p) => `<span class="tag-badge">${escapeHtml((p.country && p.country.tag) || "?")}</span>` },
    { key: "governmentType", label: "Government", render: (p) => escapeHtml((p.country && p.country.governmentType) || "-") },
    { key: "scorePlace", label: "Rank", numeric: true, lowerIsBetter: true, render: (p) => fmtNum(p.country && p.country.scorePlace, 0) },
    { key: "locationCount", label: "Locations", numeric: true, render: (p) => fmtNum(p.country && p.country.locationCount, 0) },
    { key: "totalDevelopment", label: "Development", numeric: true, render: (p) => fmtNum(p.country && p.country.totalDevelopment, 1) },
    { key: "avgDevelopment", label: "Avg Dev/location", numeric: true, render: (p) => fmtNum(p.country && p.country.avgDevelopment, 2) },
    { key: "gold", label: "Treasury", numeric: true, render: (p) => fmtNum(p.country && p.country.gold, 1) },
    { key: "lastMonthGoldIncome", label: "Income/mo", numeric: true, render: (p) => fmtNum(p.country && p.country.lastMonthGoldIncome, 2) },
    { key: "tradeIncome", label: "State Trade Income (Last Month)", numeric: true, render: (p) => fmtNum(p.country && p.country.tradeIncome, 2) },
    { key: "taxIncome", label: "State Tax Income (Last Month)", numeric: true, render: (p) => fmtNum(p.country && p.country.taxIncome, 2) },
    { key: "latestTaxBase", label: "Base Tax", numeric: true, render: (p) => fmtNum(p.country && p.country.latestTaxBase, 1) },
    { key: "latestEconomicalBase", label: "Economic Base", numeric: true, render: (p) => fmtNum(p.country && p.country.latestEconomicalBase, 1) },
    { key: "profit", label: "Profit", numeric: true, render: (p) => fmtNum(p.country && p.country.profit, 1) },
    {
      key: "efficiency",
      label: "Profit Efficiency",
      numeric: true,
      render: (p) => (p.country && typeof p.country.efficiency === "number" ? (p.country.efficiency * 100).toFixed(0) + "%" : "-"),
    },
    { key: "population", label: "Population (people)", numeric: true, render: (p) => fmtPopulation(p.country && p.country.population) },
    { key: "incomePerPop", label: "GDP (Income/1k people)", numeric: true, render: (p) => fmtNum(p.country && p.country.incomePerPop, 3) },
    { key: "taxBasePerPop", label: "Tax Base/1k people", numeric: true, render: (p) => fmtNum(p.country && p.country.taxBasePerPop, 3) },
    { key: "manpower", label: "Manpower (k)", numeric: true, render: (p) => fmtNum(p.country && p.country.manpower, 2) },
    { key: "manpowerPerPop", label: "Manpower/1k people", numeric: true, render: (p) => fmtNum(p.country && p.country.manpowerPerPop, 3) },
    { key: "armyTotalK", label: "Active Army (k)", numeric: true, render: (p) => fmtNum(p.country && p.country.armyTotalK, 2) },
    { key: "armyTotal", label: "Active Regiments", numeric: true, render: (p) => fmtNum(p.country && p.country.armyTotal, 0) },
    { key: "armyLeviesK", label: "Levies (k)", numeric: true, render: (p) => fmtNum(p.country && p.country.armyLeviesK, 2) },
    { key: "armyLevies", label: "Levy Regiments", numeric: true, render: (p) => fmtNum(p.country && p.country.armyLevies, 0) },
    { key: "armyRegularsK", label: "Regulars (k)", numeric: true, render: (p) => fmtNum(p.country && p.country.armyRegularsK, 2) },
    { key: "armyRegulars", label: "Regular Regiments", numeric: true, render: (p) => fmtNum(p.country && p.country.armyRegulars, 0) },
    { key: "armyMercenariesK", label: "Mercenaries (k)", numeric: true, render: (p) => fmtNum(p.country && p.country.armyMercenariesK, 2) },
    { key: "armyMercenaries", label: "Merc. Regiments", numeric: true, render: (p) => fmtNum(p.country && p.country.armyMercenaries, 0) },
    { key: "admScore", label: "ADM", numeric: true, render: (p) => fmtNum(p.country && p.country.admScore, 2) },
    { key: "dipScore", label: "DIP", numeric: true, render: (p) => fmtNum(p.country && p.country.dipScore, 2) },
    { key: "milScore", label: "MIL", numeric: true, render: (p) => fmtNum(p.country && p.country.milScore, 2) },
    { key: "stability", label: "Stability", numeric: true, render: (p) => fmtNum(p.country && p.country.stability, 1) },
    { key: "prestige", label: "Prestige", numeric: true, render: (p) => fmtNum(p.country && p.country.prestige, 1) },
    { key: "greatPowerRank", label: "GP Rank", numeric: true, lowerIsBetter: true, render: (p) => fmtNum(p.country && p.country.greatPowerRank, 0) },
    { key: "sailors", label: "Sailors (k)", numeric: true, render: (p) => fmtNum(p.country && p.country.sailors, 2) },
    { key: "navyShips", label: "Navy Size", numeric: true, render: (p) => fmtNum(p.country && p.country.navyShips, 0) },
    {
      key: "__hide",
      label: "",
      render: (p) => `<button class="hide-player-btn" data-name="${escapeHtml(p.name || "")}" title="Hide this player (they left the campaign)">Hide</button>`,
    },
  ];

  function estatePlayerColumns(rows) {
    const columns = [];
    appendColumns(columns, estateColumnsForGroup(selectedEstateMetricGroup(), (row, key) => estateMetricValue(row.country, key), rows));
    return columns;
  }

  function estateTabsHtml() {
    if (!activeEstateTaxGroups.length) return "";
    const selected = selectedEstateMetricGroup();
    return `<div class="estate-metric-tabs" role="group" aria-label="Estate metrics">
      ${activeEstateTaxGroups
        .map(
          (group) => `<button type="button" class="estate-metric-tab${selected && selected.key === group.key ? " active" : ""}" data-estate="${escapeHtml(group.key)}" title="${escapeHtml(group.label)}">
            <img class="estate-metric-icon" src="${estateIcon(group.key)}" alt="" loading="lazy">
            <span>${escapeHtml(group.label)}</span>
          </button>`
        )
        .join("")}
    </div>`;
  }

  function attachEstateTabHandlers(container) {
    container.querySelectorAll(".estate-metric-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        const next = btn.dataset.estate;
        if (!next || next === currentEstateMetricGroup) return;
        currentEstateMetricGroup = next;
        if (currentPlayerMetricGroup === "estates") drawPlayerTable();
        if (currentMetricGroup === "estates") drawCountryTable();
      });
    });
  }

  const PLAYER_COUNTRY_SORT_KEYS = [
    "scorePlace",
    "locationCount",
    "totalDevelopment",
    "avgDevelopment",
    "gold",
    "lastMonthGoldIncome",
    "tradeIncome",
    "taxIncome",
    "latestTaxBase",
    "latestEconomicalBase",
    "profit",
    "efficiency",
    "population",
    "incomePerPop",
    "taxBasePerPop",
    "manpowerPerPop",
    "manpower",
    "sailors",
    "armyTotalK",
    "armyLeviesK",
    "armyRegularsK",
    "armyMercenariesK",
    "armyTotal",
    "armyLevies",
    "armyRegulars",
    "armyMercenaries",
    "navyShips",
    "admScore",
    "dipScore",
    "milScore",
    "stability",
    "prestige",
    "greatPowerRank",
  ];

  const COUNTRY_METRIC_GROUPS = {
    key: ["tag", "playerNames", "lastMonthGoldIncome", "latestTaxBase", "profit", "efficiency", "population", "manpowerPerPop"],
    economy: [
      "tag",
      "playerNames",
      "gold",
      "lastMonthGoldIncome",
      "income",
      "expense",
      "tradeIncome",
      "taxIncome",
      "latestTaxBase",
      "latestEconomicalBase",
      "profit",
      "efficiency",
      "lastMonthsArmyMaintenance",
      "lastMonthsNavyMaintenance",
      "incomePerPop",
      "taxBasePerPop",
    ],
    military: [
      "tag",
      "playerNames",
      "scorePlace",
      "manpower",
      "manpowerPerPop",
      "armyTotalK",
      "armyTotal",
      "armyLeviesK",
      "armyLevies",
      "armyRegularsK",
      "armyRegulars",
      "armyMercenariesK",
      "armyMercenaries",
      "sailors",
      "navyShips",
    ],
    demographic: [
      "tag",
      "playerNames",
      "greatPowerRank",
      "locationCount",
      "totalDevelopment",
      "avgDevelopment",
      "population",
      "incomePerPop",
      "taxBasePerPop",
      "manpowerPerPop",
      "stability",
      "prestige",
    ],
    estates: ["tag", "playerNames", "__estates"],
  };

  const PLAYER_METRIC_GROUPS = {
    key: ["name", "tag", "lastMonthGoldIncome", "latestTaxBase", "profit", "efficiency", "population", "manpowerPerPop", "__hide"],
    economy: ["name", "tag", "gold", "lastMonthGoldIncome", "tradeIncome", "taxIncome", "latestTaxBase", "latestEconomicalBase", "profit", "efficiency", "incomePerPop", "taxBasePerPop", "__hide"],
    military: [
      "name",
      "tag",
      "scorePlace",
      "manpower",
      "manpowerPerPop",
      "armyTotalK",
      "armyTotal",
      "armyLeviesK",
      "armyLevies",
      "armyRegularsK",
      "armyRegulars",
      "armyMercenariesK",
      "armyMercenaries",
      "sailors",
      "navyShips",
      "__hide",
    ],
    demographic: ["name", "tag", "greatPowerRank", "locationCount", "totalDevelopment", "avgDevelopment", "population", "incomePerPop", "taxBasePerPop", "stability", "prestige", "__hide"],
    estates: ["name", "tag", "__estates", "__hide"],
  };

  function countryColumnsForCurrentGroup(rows) {
    const keys = COUNTRY_METRIC_GROUPS[currentMetricGroup] || COUNTRY_METRIC_GROUPS.key;
    const columns = [];
    keys.forEach((key) => {
      if (key === "__estates") appendColumns(columns, estateCountryColumns(rows));
      else {
        const column = COUNTRY_COLUMNS.find((col) => col.key === key);
        if (column) columns.push(column);
      }
    });
    return columns;
  }

  function playerColumnsForCurrentGroup(rows) {
    const keys = PLAYER_METRIC_GROUPS[currentPlayerMetricGroup] || PLAYER_METRIC_GROUPS.key;
    const columns = [];
    keys.forEach((key) => {
      if (key === "__estates") appendColumns(columns, estatePlayerColumns(rows));
      else {
        const column = PLAYER_COLUMNS.find((col) => col.key === key);
        if (column) columns.push(column);
      }
    });
    return columns;
  }

  function isEstateMetricKey(key) {
    return /(?:PopShare|TaxBaseTotal|TaxPer1k|TaxRate|ExtractedTaxTotal|ExtractedTaxPer1k|PrivateTradeIncome)$/.test(key || "");
  }

  function sortValue(row, col) {
    if (!col) return undefined;
    if (col.key === "tag" && row.country) return row.country.tag;
    if (PLAYER_COUNTRY_SORT_KEYS.includes(col.key) && row.country) {
      return row.country[col.key];
    }
    if (row.country && isEstateMetricKey(col.key)) return row.country[col.key];
    return row[col.key];
  }

  const KEY_HEAT_COLUMNS = new Set(["lastMonthGoldIncome", "profit", "efficiency", "population", "manpowerPerPop"]);

  function metricValue(row, col) {
    const value = sortValue(row, col);
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }

  // Efficiency (profit/income) gets a FIXED 0-100% scale instead of the
  // usual per-column min/max normalization - a real save can have a country
  // losing money so badly its efficiency reads -5000% (spending 50x what it
  // makes), and normalizing 0-100% against that outlier as the "max" end
  // squished every normal country (0-100%, the entire range anyone actually
  // cares to compare) into a thin green sliver at the very top - EVERY
  // country looked "good" regardless of real standing. Any negative value
  // now reads as flatly the worst score (0) rather than getting its own
  // shade based on how catastrophically negative it is (how much worse
  // -50% is than -5000% isn't a meaningful distinction to color-code), and
  // 0-100% gets the actual gradient.
  function heatScoreFor(col, value, rows, relativeEfficiencyHeat) {
    if (col.key === "efficiency" && !relativeEfficiencyHeat) {
      if (typeof value !== "number") return undefined;
      return value <= 0 ? 0 : Math.min(1, value);
    }
    const values = rows.map((r) => metricValue(r, col)).filter((v) => typeof v === "number");
    const min = values.length ? Math.min(...values) : undefined;
    const max = values.length ? Math.max(...values) : undefined;
    if (typeof value !== "number" || typeof min !== "number" || typeof max !== "number" || max <= min) return undefined;
    const score = Math.max(0, Math.min(1, (value - min) / (max - min)));
    return col.lowerIsBetter ? 1 - score : score;
  }

  // Income/mo first (when the current metric group shows it - Key and
  // Economy both do) since that's the number players actually care about
  // ranking by; scorePlace next (Military/Demographic groups, where income
  // isn't shown); otherwise whatever the first visible column happens to be
  // (unchanged fallback behavior).
  function defaultSortKeyFor(columns) {
    if (columns.some((col) => col.key === "lastMonthGoldIncome")) return "lastMonthGoldIncome";
    const estateGroup = selectedEstateMetricGroup();
    if (estateGroup && columns.some((col) => col.key === estateExtractedTaxPer1kKey(estateGroup.key))) return estateExtractedTaxPer1kKey(estateGroup.key);
    if (estateGroup && columns.some((col) => col.key === estateExtractedTaxTotalKey(estateGroup.key))) return estateExtractedTaxTotalKey(estateGroup.key);
    if (columns.some((col) => col.key === "scorePlace")) return "scorePlace";
    return columns[0] && columns[0].key;
  }

  function renderSortableTable(container, rows, columns, options) {
    options = options || {};
    let sortKey = options.defaultSortKey || (columns[0] && columns[0].key);
    let sortDir = options.defaultSortDir || -1;

    function draw() {
      const sorted = rows.slice().sort((a, b) => {
        const col = columns.find((c) => c.key === sortKey);
        const av = sortValue(a, col);
        const bv = sortValue(b, col);
        if (av === undefined || av === null) return 1;
        if (bv === undefined || bv === null) return -1;
        if (av < bv) return -1 * sortDir;
        if (av > bv) return 1 * sortDir;
        return 0;
      });

      const thead = columns
        .map((col) => {
          const isSorted = col.key === sortKey;
          const arrow = isSorted ? `<span class="arrow">${sortDir === 1 ? "▲" : "▼"}</span>` : "";
          const desc = col.title || COLUMN_DESCRIPTIONS[col.key];
          const titleAttr = desc ? ` title="${escapeHtml(desc)}"` : "";
          const classes = [isSorted ? "sorted" : "", desc ? "has-desc" : ""].filter(Boolean).join(" ");
          return `<th data-key="${col.key}" class="${classes}"${titleAttr}>${escapeHtml(col.label)}${arrow}</th>`;
        })
        .join("");

      const tbody = sorted
        .map((row) => {
          const cells = columns
            .map((col) => {
              const classes = [col.numeric ? "num" : ""];
              let style = "";
              if (options.colorKeyMetrics && (options.colorAllNumericMetrics ? col.numeric : KEY_HEAT_COLUMNS.has(col.key) || col.heatColumn)) {
                const value = metricValue(row, col);
                const score = heatScoreFor(col, value, rows, options.relativeEfficiencyHeat);
                if (typeof score === "number") {
                  classes.push("metric-heat");
                  style = ` style="--metric-score:${score.toFixed(3)}"`;
                }
              }
              return `<td class="${classes.filter(Boolean).join(" ")}"${style}>${col.render(row)}</td>`;
            })
            .join("");
          return `<tr class="${row.__isPlayerCountry ? "is-player" : ""}">${cells}</tr>`;
        })
        .join("");

      const tableClass = columns.length >= 12 ? ' class="dense-metric-table"' : "";
      const headerHtml = options.headerHtml ? options.headerHtml() : "";
      container.innerHTML = `${headerHtml}<table${tableClass}><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`;

      container.querySelectorAll("th").forEach((th) => {
        th.addEventListener("click", () => {
          const key = th.dataset.key;
          if (key === sortKey) sortDir *= -1;
          else {
            sortKey = key;
            sortDir = -1;
          }
          draw();
        });
      });

      if (options.onRender) options.onRender(container);
    }

    draw();
    return { redraw: draw, setRows: (newRows) => { rows = newRows; draw(); } };
  }

  let hiddenNoteEl = null;

  function drawPlayerTable(result) {
    result = result || latestResult;
    if (!result) return;
    if (!hiddenNoteEl) {
      hiddenNoteEl = document.createElement("div");
      hiddenNoteEl.className = "hidden-players-note";
      playersTableEl.parentNode.insertBefore(hiddenNoteEl, playersTableEl);
    }

    const visible = visiblePlayers(result);
    playerCountEl.textContent = visible.length;

    const hiddenCount = result.players.length - visible.length;
    hiddenNoteEl.innerHTML = hiddenCount
      ? `${hiddenCount} player${hiddenCount === 1 ? "" : "s"} hidden. <button class="link-btn" id="showHiddenPlayersBtn">Show</button>`
      : "";
    const showBtn = document.getElementById("showHiddenPlayersBtn");
    if (showBtn) {
      showBtn.addEventListener("click", () => {
        setExcludedPlayers(new Set());
        drawPlayerTable(result);
        renderTrends(result);
        if (currentLlamaDraw) currentLlamaDraw();
        refreshMapForExclusions();
      });
    }

    const columns = playerColumnsForCurrentGroup(visible);
    renderSortableTable(playersTableEl, visible, columns, {
      defaultSortKey: defaultSortKeyFor(columns),
      colorKeyMetrics: true,
      colorAllNumericMetrics: true,
      // Unlike the Countries table (1000+ rows, real risk of a catastrophic
      // outlier squishing everyone else into a thin green sliver - see
      // heatScoreFor), the Players table is a handful of rows where relative
      // worst-to-best ranking is exactly what's useful.
      relativeEfficiencyHeat: true,
      headerHtml: currentPlayerMetricGroup === "estates" ? estateTabsHtml : null,
      onRender: (container) => {
        if (currentPlayerMetricGroup === "estates") attachEstateTabHandlers(container);
        container.querySelectorAll(".hide-player-btn").forEach((btn) => {
          btn.addEventListener("click", () => {
            const excluded = getExcludedPlayers();
            excluded.add(btn.dataset.name);
            setExcludedPlayers(excluded);
            drawPlayerTable(result);
            renderTrends(result);
            // A hidden/departed player should also stop scoring in the
            // Llama Score tab, not just disappear from this table - see
            // computeLlamaScores'/computeFromLedger's excludedPlayers param.
            if (currentLlamaDraw) currentLlamaDraw();
            refreshMapForExclusions();
          });
        });
      },
    });
  }

  function renderPlayers(result) {
    drawPlayerTable(result);
  }

  let countriesController = null;

  // Derived economy metrics - computed once per country rather than per
  // render/sort, since sortValue() otherwise expects a plain property.
  function computeDerivedMetrics(c) {
    c.profit = typeof c.income === "number" && typeof c.expense === "number" ? c.income - c.expense : undefined;
    // "Efficiency": share of gross income kept as profit, not spent - 1.0
    // means no expenses at all, 0 means spending exactly what you make.
    c.efficiency = typeof c.profit === "number" && c.income > 0 ? c.profit / c.income : undefined;
    // Base Tax and Economic Base have no dedicated current-value field that
    // survives across game versions (`current_tax_base` exists on 1.1.x saves
    // but was dropped by 1.3.x; `current_economical_base` never existed) - but
    // both `historical_*_base` arrays' LAST entry is always "now", so that's
    // the version-stable source for the current figure. historicalEconomicalBase
    // is itself newer (absent on pre-1.3 saves), so Economic Base is simply
    // blank on an older save rather than wrong.
    c.latestTaxBase = Array.isArray(c.historicalTaxBase) && c.historicalTaxBase.length ? c.historicalTaxBase[c.historicalTaxBase.length - 1] : undefined;
    c.latestEconomicalBase = Array.isArray(c.historicalEconomicalBase) && c.historicalEconomicalBase.length ? c.historicalEconomicalBase[c.historicalEconomicalBase.length - 1] : undefined;
    c.incomePerPop = typeof c.lastMonthGoldIncome === "number" && c.population > 0 ? c.lastMonthGoldIncome / c.population : undefined;
    c.taxBasePerPop = typeof c.latestTaxBase === "number" && c.population > 0 ? c.latestTaxBase / c.population : undefined;
    c.manpowerPerPop = typeof c.manpower === "number" && c.population > 0 ? c.manpower / c.population : undefined;
  }

  function computeCountryLocationMetrics(result) {
    const byCountry = new Map((result.countries || []).map((c) => [c.number, c]));
    const totals = new Map();
    const discoveredEstateGroups = new Map(BASE_ESTATE_TAX_GROUPS.map((group) => [group.key, group.label]));
    const popsById = populationRecordMap(result);
    const hasPopRecords = popsById.size > 0;
    const privateTradeIncomeByCountry = new Map();
    for (const entry of result.estateTradeIncomes || []) {
      if (!entry || typeof entry.country !== "number" || typeof entry.tradeIncome !== "number") continue;
      const group = estateMetricGroup(entry.estateType);
      if (!group || group === "crown") continue;
      if (!discoveredEstateGroups.has(group)) discoveredEstateGroups.set(group, estateMetricLabel(group));
      if (!privateTradeIncomeByCountry.has(entry.country)) privateTradeIncomeByCountry.set(entry.country, new Map());
      const byEstate = privateTradeIncomeByCountry.get(entry.country);
      byEstate.set(group, (byEstate.get(group) || 0) + entry.tradeIncome);
    }
    for (const country of result.countries || []) {
      for (const estate of Object.keys(country.taxRates || {})) {
        const group = estateTaxMetricGroup(estate);
        if (group !== "crown" && !discoveredEstateGroups.has(group)) discoveredEstateGroups.set(group, estateMetricLabel(group));
      }
    }
    for (const loc of result.locations || []) {
      if (!loc || typeof loc.owner !== "number") continue;
      const row = totals.get(loc.owner) || { development: 0, locations: 0, estateSharePop: {}, estateTaxPop: {}, estateTax: {} };
      if (typeof loc.development === "number") row.development += loc.development;
      if (hasPopRecords && Array.isArray(loc.popIds) && loc.popIds.length) {
        for (const popId of loc.popIds) {
          const pop = popsById.get(popId);
          if (!pop || typeof pop.size !== "number") continue;
          const shareGroup = estateMetricGroup(pop.estate || pop.type);
          const taxGroup = estateTaxMetricGroup(pop.estate || pop.type);
          if (!discoveredEstateGroups.has(shareGroup)) discoveredEstateGroups.set(shareGroup, estateMetricLabel(shareGroup));
          if (!discoveredEstateGroups.has(taxGroup)) discoveredEstateGroups.set(taxGroup, estateMetricLabel(taxGroup));
          row.estateSharePop[shareGroup] = (row.estateSharePop[shareGroup] || 0) + pop.size;
          row.estateTaxPop[taxGroup] = (row.estateTaxPop[taxGroup] || 0) + pop.size;
        }
      } else {
        for (const popClass of loc.populationClasses || []) {
          if (typeof popClass.total !== "number") continue;
          const shareGroup = estateMetricGroup(popClass.name);
          const taxGroup = estateTaxMetricGroup(popClass.name);
          if (!discoveredEstateGroups.has(shareGroup)) discoveredEstateGroups.set(shareGroup, estateMetricLabel(shareGroup));
          if (!discoveredEstateGroups.has(taxGroup)) discoveredEstateGroups.set(taxGroup, estateMetricLabel(taxGroup));
          row.estateSharePop[shareGroup] = (row.estateSharePop[shareGroup] || 0) + popClass.total;
          row.estateTaxPop[taxGroup] = (row.estateTaxPop[taxGroup] || 0) + popClass.total;
        }
      }
      for (const [estate, value] of Object.entries(loc.estateTax || {})) {
        if (typeof value !== "number") continue;
        const group = estateTaxMetricGroup(estate);
        if (group === "crown") continue;
        if (!discoveredEstateGroups.has(group)) discoveredEstateGroups.set(group, estateMetricLabel(group));
        row.estateTax[group] = (row.estateTax[group] || 0) + value;
      }
      row.locations += 1;
      totals.set(loc.owner, row);
    }
    activeEstateTaxGroups = [...discoveredEstateGroups.entries()].map(([key, label]) => ({ key, label }));
    if (!activeEstateTaxGroups.some((group) => group.key === currentEstateMetricGroup)) {
      currentEstateMetricGroup = activeEstateTaxGroups[0] ? activeEstateTaxGroups[0].key : "commoners";
    }
    for (const country of result.countries || []) {
      const byEstate = privateTradeIncomeByCountry.get(country.number);
      for (const group of activeEstateTaxGroups) {
        country[estatePrivateTradeIncomeKey(group.key)] = byEstate ? byEstate.get(group.key) : undefined;
      }
    }
    for (const [countryNumber, row] of totals.entries()) {
      const country = byCountry.get(countryNumber);
      if (!country) continue;
      country.totalDevelopment = row.development;
      country.avgDevelopment = row.locations > 0 ? row.development / row.locations : undefined;
      const totalEstatePop = Object.values(row.estateSharePop).reduce((sum, value) => sum + (typeof value === "number" ? value : 0), 0);
      const countryEstateTaxRates = {};
      for (const [estate, value] of Object.entries(country.taxRates || {})) {
        if (typeof value !== "number") continue;
        const group = estateTaxMetricGroup(estate);
        if (group === "crown") continue;
        countryEstateTaxRates[group] = value;
      }
      for (const group of activeEstateTaxGroups) {
        const sharePop = row.estateSharePop[group.key] || 0;
        const taxPop = row.estateTaxPop[group.key] || 0;
        const tax = row.estateTax[group.key] || 0;
        const basePer1k = taxPop > 0 ? tax / taxPop : undefined;
        const rate =
          country.taxRates && Object.prototype.hasOwnProperty.call(countryEstateTaxRates, group.key)
            ? countryEstateTaxRates[group.key]
            : country.taxRates
              ? 0
              : undefined;
        country[estateShareKey(group.key)] = totalEstatePop > 0 ? sharePop / totalEstatePop : undefined;
        country[estateTaxBaseTotalKey(group.key)] = tax;
        country[estateTaxPer1kKey(group.key)] = basePer1k;
        country[estateTaxRateKey(group.key)] = rate;
        country[estateExtractedTaxTotalKey(group.key)] = typeof rate === "number" ? tax * rate : undefined;
        country[estateExtractedTaxPer1kKey(group.key)] = typeof basePer1k === "number" && typeof rate === "number" ? basePer1k * rate : undefined;
      }
    }
  }

  function filteredCountries() {
    const q = countrySearch.value.trim().toLowerCase();
    return !q
      ? latestCountries
      : latestCountries.filter(
          (c) =>
            (c.tag || "").toLowerCase().includes(q) ||
            (c.governmentType || "").toLowerCase().includes(q) ||
            (c.players || []).some((p) => p.toLowerCase().includes(q))
        );
  }

  function drawCountryTable() {
    const rows = filteredCountries();
    const columns = countryColumnsForCurrentGroup(rows);
    const defaultSortKey = defaultSortKeyFor(columns);
    countriesController = renderSortableTable(countriesTableEl, rows, columns, {
      defaultSortKey,
      colorKeyMetrics: currentMetricGroup === "key" || currentMetricGroup === "estates",
      headerHtml: currentMetricGroup === "estates" ? estateTabsHtml : null,
      onRender: currentMetricGroup === "estates" ? attachEstateTabHandlers : null,
    });
  }

  function renderCountries(result) {
    latestCountries = result.countries.filter(isRealTerritorialCountry);
    countryCountEl.textContent = latestCountries.length;
    drawCountryTable();
  }

  countrySearch.addEventListener("input", () => {
    if (!latestCountries.length) return;
    drawCountryTable();
  });

  // --- Save history (js/save-library.js) ---

  // Bumped whenever a parser change adds/changes fields the UI depends on
  // (e.g. blackDeath.deathsByCountry, 2026-07-10) - loadFromLibrary() below
  // uses this to detect a cached result.result that predates the change
  // rather than silently rendering it as if it were current (a stale cached
  // save previously showed an empty Black Death table with no indication
  // why: the library stores the fully-parsed result object, not the
  // original file, so there's nothing to re-parse from - the cache entry
  // just needs to be dropped and the save re-uploaded).
  // v3 (2026-07-10): added provinceOwnerByDefinition + the province-level
  // owner fallback (js/map.js's applyProvinceOwnerFallback) - a cached save
  // from before this predates the fix and would keep showing individual
  // locations as unowned even though the code is now correct, since the
  // fallback has nothing to fall back to without the province data.
  // v7 (2026-07-16): each result.popRecords entry now carries `culture` (not
  // just religion/estate/size) - the Culture/Religion map modes' pop-weighted
  // secondary-group hash pattern needs it per-pop. A cached save from before
  // this predates the field entirely, so its map would silently fall back to
  // the old flat single-color fill with no visible error.
  // v8 (2026-07-17): added result.estateTradeIncomes (per-estate
  // last_month.trade_income, summed per country into country.tradeIncome for
  // the Economy tab's new "Trade Income" column) - a cached save from before
  // this predates the field entirely, so that column would silently show
  // nothing rather than an error.
  // v9 (2026-07-17): estateTradeIncomes entries now also carry `paidTaxes`
  // (per-estate last_month.paid_taxes, summed per country into
  // country.taxIncome for the Economy tab's new "Tax Income" column) - a
  // cached save from before this predates the field entirely.
  // v10 (2026-07-17): added result.armySubunitDetails (per-regiment
  // controller/category/type/strength, joined against the optional local
  // game_data/unit_sizes.json to compute real troop headcounts for the
  // Military tab's new Army/Levies/Regulars/Mercenaries "(k)" columns) - a
  // cached save from before this predates the field entirely, so those
  // columns would silently show nothing.
  // v11 (2026-07-17): added the Military tab's "(k)" troop-headcount columns,
  // fed by armySubunitDetails' per-regiment `strength`.
  // v12 (2026-07-18): corrected what `strength` MEANS - it's the regiment's
  // current troop count in "thousands" units (0.40 = 400 men), not a 0-1 fill
  // fraction to multiply by a separately-derived unit max size (which
  // double-counted and read ~2.5x low). The "(k)" columns are now just the sum
  // of strength, and an absent strength field is read as an unraised levy (0
  // troops) rather than a phantom full regiment. A cached save from before
  // this carries the old per-regiment strength baked in - needs a fresh parse.
  // v13 (2026-07-23): country.lastMonthsTradeIncome now reads the real
  // country-level last_months_trade_income field (binary token 0x36f8), and
  // the Economy table uses it instead of summing estates' private
  // last_month.trade_income pools.
  const RESULT_SCHEMA_VERSION = 13;

  function saveResultToLibrary(fileName, result) {
    if (typeof SaveLibrary === "undefined" || !SaveLibrary.available) return;
    result.__schemaVersion = RESULT_SCHEMA_VERSION;
    SaveLibrary.put(fileName, result)
      .then(refreshSavesLibraryUI)
      .catch((err) => {
        if (typeof console !== "undefined") console.warn("Could not save to local save history:", err);
      });
  }

  // Turns a "Y.M.D[.H]" in-game date string into a value that sorts
  // chronologically - plain string comparison breaks on single- vs double-
  // digit months/days ("1444.10.1" sorts before "1444.9.1" as text).
  function gameDateSortValue(dateStr) {
    if (!dateStr) return -Infinity;
    const [year, month, day, hour] = String(dateStr)
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
    return ((((year || 0) * 12 + (month || 0)) * 31 + (day || 0)) * 24) + (hour || 0);
  }

  const SAVE_LIBRARY_COLUMNS = [
    { key: "playthroughName", label: "Playthrough", render: (r) => escapeHtml(r.playthroughName || "-") },
    { key: "playerCountryName", label: "Your Nation", render: (r) => escapeHtml(r.playerCountryName || "-") },
    { key: "fileName", label: "File", render: (r) => escapeHtml(r.fileName || "-") },
    { key: "gameDateSort", label: "In-game date", render: (r) => escapeHtml(r.gameDate || "-") },
    { key: "uploadedAt", label: "Uploaded", numeric: true, render: (r) => escapeHtml(r.uploadedAt ? new Date(r.uploadedAt).toLocaleString() : "-") },
    { key: "__load", label: "", render: (r) => `<button type="button" class="link-btn save-library-load-btn" data-id="${escapeHtml(r.id)}">Load</button>` },
    { key: "__remove", label: "", render: (r) => `<button type="button" class="link-btn save-library-remove-btn" data-id="${escapeHtml(r.id)}" title="Remove from history">Remove</button>` },
  ];

  function loadFromLibrary(id) {
    SaveLibrary.get(id).then((record) => {
      if (!record) return;
      onParsed(record.result, { persist: false, displayName: record.fileName, libraryId: id });
    });
  }

  function removeStaleLibraryEntry(id) {
    if (!id) return;
    SaveLibrary.remove(id).then(() => {
      refreshSavesLibraryUI();
      latestResult = null;
      setResultTabsAvailable(false);
      activateTab("load");
      uploaderSummaryEl.hidden = true;
      dropzone.hidden = false;
      errorBox.hidden = true;
    });
  }

  function refreshSavesLibraryUI() {
    if (typeof SaveLibrary === "undefined" || !SaveLibrary.available) return;
    SaveLibrary.list().then((records) => {
      savesLibraryPanel.hidden = records.length === 0;
      if (!records.length) return;
      const rows = records.map((r) => ({ ...r, gameDateSort: gameDateSortValue(r.gameDate) }));
      renderSortableTable(savesLibraryTableEl, rows, SAVE_LIBRARY_COLUMNS, {
        defaultSortKey: "uploadedAt",
        onRender: (container) => {
          container.querySelectorAll(".save-library-load-btn").forEach((btn) => {
            btn.addEventListener("click", () => loadFromLibrary(btn.dataset.id));
          });
          container.querySelectorAll(".save-library-remove-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
              SaveLibrary.remove(btn.dataset.id).then(refreshSavesLibraryUI);
            });
          });
        },
      });
    });
  }

  // --- Shareable/restorable URL state ---
  //
  // A "?save=<id>&tab=<tab>" link carries a stable save id (playthrough uuid +
  // game date, see save-library.js's deriveSaveId) plus the active tab.
  // Resolving it, in order of preference:
  //   1. This browser's own local history (IndexedDB) - instant, no network.
  //   2. The shared-save backend (Supabase Storage, see js/share-store.js) -
  //      lets a link hand the actual save to a recipient who never uploaded
  //      it. Only active when config.js is present (a configured deploy);
  //      absent in a plain checkout, where this degrades to local-only.
  //   3. Otherwise, prompt the user to drop that save file in.
  // Uploading to the backend happens only on an explicit Share click, never
  // automatically - a save you merely open never leaves your browser.

  function updateShareUrl() {
    if (!latestResult || typeof SaveLibrary === "undefined") return;
    const params = new URLSearchParams();
    params.set("save", SaveLibrary.deriveSaveId(latestResult));
    params.set("tab", currentTab);
    history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
  }

  // Save ids are "<playthroughId>_<gameDate>" (see save-library.js); pull
  // the date back out for a human-readable prompt without needing the full
  // parsed result.
  function decodeShareDate(id) {
    const idx = id.indexOf("_");
    return idx === -1 ? null : id.slice(idx + 1);
  }

  function showPendingShareNotice(id) {
    const date = decodeShareDate(id);
    pendingShareNoticeEl.hidden = false;
    pendingShareNoticeEl.textContent = date
      ? `This link is for a save from ${date} - drop that save file in above to view it.`
      : "This link is for a specific save that isn't in this browser's history yet - drop that save file in above to view it.";
  }

  function initFromShareUrl() {
    const params = new URLSearchParams(location.search);
    const id = params.get("save");
    if (!id) return;
    const requestedTab = params.get("tab");
    pendingShareTab = VALID_TABS.includes(requestedTab) ? requestedTab : "metrics";

    // Fastest path first: this browser already has the save locally (its own
    // upload, or a previous visit to this link that cached it) - no network.
    const local = typeof SaveLibrary !== "undefined" && SaveLibrary.available ? SaveLibrary.get(id) : Promise.resolve(null);
    local
      .then((record) => {
        if (record) {
          onParsed(record.result, { persist: false, displayName: record.fileName });
          activateTab(pendingShareTab);
          return;
        }
        return loadSharedSaveOrPrompt(id);
      })
      .catch(() => loadSharedSaveOrPrompt(id));
  }

  // Local miss: try the shared-save backend (someone handed this link to a
  // recipient who never uploaded the save - see js/share-store.js). On
  // success, render it exactly like a freshly-parsed save AND cache it
  // locally so reopening the link is instant/offline. On a miss or a build
  // with no backend configured, fall back to the existing "drop that save
  // file in" prompt.
  function loadSharedSaveOrPrompt(id) {
    if (typeof ShareStore === "undefined" || !ShareStore.isConfigured()) {
      pendingShareId = id;
      activateTab("load");
      showPendingShareNotice(id);
      return;
    }
    activateTab("load");
    pendingShareNoticeEl.hidden = false;
    pendingShareNoticeEl.textContent = "Loading shared save…";
    return ShareStore.fetch(id)
      .then((result) => {
        if (!result) {
          pendingShareId = id;
          showPendingShareNotice(id);
          return;
        }
        pendingShareNoticeEl.hidden = true;
        onParsed(result, { displayName: sharedDisplayName(id, result) });
        activateTab(pendingShareTab);
      })
      .catch((err) => {
        pendingShareId = id;
        const date = decodeShareDate(id);
        pendingShareNoticeEl.hidden = false;
        pendingShareNoticeEl.textContent = `Couldn't load the shared save (${err.message}). Drop the ${
          date ? `save from ${date}` : "save file"
        } in above to view it.`;
      });
  }

  function sharedDisplayName(id, result) {
    const name = result && result.metadata && result.metadata.playthrough_name;
    const date = decodeShareDate(id);
    return `Shared: ${name || "campaign"}${date ? ` (${date})` : ""}`;
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return Promise.reject(new Error("clipboard unavailable"));
  }

  function flashCopyLink(msg) {
    copyLinkBtn.textContent = msg;
    setTimeout(() => {
      copyLinkBtn.textContent = copyLinkBtn.dataset.label || "Copy link";
    }, 2000);
  }

  // Pushes whatever campaign ledger is CURRENTLY DISPLAYED on the Llama
  // Score tab (however it got loaded - auto-connected folder, manual file
  // pickers, or even a previous remote fetch) up to Supabase as part of
  // "Share link", so a recipient with no recorder folder of their own still
  // sees real war data instead of "no recorder ledger loaded" - see
  // tryRemoteCampaignLedger's read side. Upsert-based (same as the CLI
  // import script), so re-sharing after more games are recorded just adds
  // to what's already there. Best-effort: a failure here shouldn't block
  // the save link itself from being shared.
  async function uploadCurrentLlamaLedger() {
    if (typeof ShareStore === "undefined" || !ShareStore.uploadCampaignLedger) return;
    if (!Array.isArray(llamaSnapshotsLedger) || !llamaSnapshotsLedger.length) return;
    try {
      const campaignKey = pickLatestCampaignKey(llamaSnapshotsLedger);
      if (!campaignKey) return;
      const { snapshots, events } = filterLedgerToCampaign(llamaSnapshotsLedger, llamaEventsLedger || [], campaignKey);
      const { campaign, snapshots: shapedSnapshots, events: shapedEvents } = await shapeCampaignLedgerForUpload(campaignKey, snapshots, events);
      await ShareStore.uploadCampaignLedger(campaign, shapedSnapshots, shapedEvents);
    } catch (err) {
      if (typeof console !== "undefined") console.warn("Ledger upload failed (save link was still shared):", err);
    }
  }

  // A configured backend turns "Copy link" into a real share (upload the
  // compressed save, then copy a link anyone can open); without one it stays
  // the old local-only copy. Label reflects which one you get.
  const shareBackendOn = typeof ShareStore !== "undefined" && ShareStore.isConfigured();
  if (shareBackendOn) {
    copyLinkBtn.textContent = "Share link";
    copyLinkBtn.title = "Upload this save and copy a link anyone can open";
  }
  copyLinkBtn.dataset.label = copyLinkBtn.textContent;

  copyLinkBtn.addEventListener("click", async () => {
    if (!latestResult) return;
    updateShareUrl();
    const saveId = typeof SaveLibrary !== "undefined" ? SaveLibrary.deriveSaveId(latestResult) : null;

    if (shareBackendOn && saveId) {
      copyLinkBtn.disabled = true;
      copyLinkBtn.textContent = "Sharing…";
      try {
        latestResult.__schemaVersion = RESULT_SCHEMA_VERSION;
        await ShareStore.upload(saveId, latestResult);
        await uploadCurrentLlamaLedger();
        await copyToClipboard(location.href).catch(() => {});
        flashCopyLink("Link copied — anyone can view");
      } catch (err) {
        await copyToClipboard(location.href).catch(() => {});
        flashCopyLink("Upload failed — copied local link");
        if (typeof console !== "undefined") console.warn("Shared-save upload failed:", err);
      } finally {
        copyLinkBtn.disabled = false;
      }
      return;
    }

    copyToClipboard(location.href)
      .then(() => flashCopyLink("Copied!"))
      .catch(() => {});
  });

  // "Copy image" buttons on each table/chart panel - separate from the save-
  // link sharing above, this just puts a picture of the current view on the
  // clipboard so it can be pasted straight into Discord. Targets the actual
  // <table> element (not the surrounding `.table-wrap`, which is a scrollable
  // `max-height` box) so a long Countries table captures every row, not just
  // whatever's currently scrolled into view. `js/copy-image.js` (loaded
  // before this file) does the actual rasterization/clipboard work.
  function wireTableCopyImageButton(btn, containerEl, filename) {
    if (!btn || !containerEl) return;
    CopyImage.wireCopyImageButton(
      btn,
      () => {
        const target = containerEl.querySelector("table") || containerEl;
        return CopyImage.elementToCanvas(target);
      },
      { filename }
    );
  }
  wireTableCopyImageButton(copyPlayersImageBtn, playersTableEl, "players.png");
  wireTableCopyImageButton(copyBlackDeathImageBtn, blackDeathTableEl, "black-death.png");
  wireTableCopyImageButton(copyCountriesImageBtn, countriesTableEl, "countries.png");
  if (copyTrendsImageBtn) {
    CopyImage.wireCopyImageButton(
      copyTrendsImageBtn,
      () => CopyImage.elementToCanvas(document.querySelector(".trends-grid")),
      { filename: "trends.png" }
    );
  }

  // The inline <script> in index.html's <head> already stamped data-theme
  // from localStorage (if any) before this file even loaded, to avoid a
  // flash of the wrong theme - this just keeps the toggle button's own icon
  // in sync with whatever's actually in effect. Dark is the default (an
  // explicit product choice, not tied to OS preference) - only an explicit
  // "light" ever switches it, so anything else (unset, or literally "dark")
  // counts as dark.
  function currentEffectiveTheme() {
    return document.documentElement.dataset.theme === "light" ? "light" : "dark";
  }

  function syncThemeToggleButton() {
    const isDark = currentEffectiveTheme() === "dark";
    themeToggleBtn.textContent = isDark ? "☀" : "☾"; // sun (switch to light) / crescent moon (switch to dark)
    themeToggleBtn.title = isDark ? "Switch to light mode" : "Switch to dark mode";
    themeToggleBtn.setAttribute("aria-label", themeToggleBtn.title);
  }

  themeToggleBtn.addEventListener("click", () => {
    const next = currentEffectiveTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch (e) {}
    syncThemeToggleButton();
    // Re-render whatever's currently drawn so already-built charts (which
    // bake resolved colors into their SVG at render time, not live CSS
    // references) pick up the new theme's tokens immediately instead of
    // only on the next data change.
    if (latestResult) {
      renderTrends(latestResult);
      if (currentLlamaDraw) currentLlamaDraw();
    }
  });
  syncThemeToggleButton();

  activateTab("home");
  updateLlamaPanelVisibility();
  initFromShareUrl();
  refreshSavesLibraryUI();
  tryAutoReconnect();
})();
