(function () {
  "use strict";

  const fileInput = document.getElementById("fileInput");
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
  const pendingShareNoticeEl = document.getElementById("pendingShareNotice");
  const countryMetricTabs = document.querySelectorAll("#metricTabs .metric-tab");
  const playerMetricTabs = document.querySelectorAll("#playerMetricTabs .metric-tab");
  const tabButtons = document.querySelectorAll(".app-tab");
  const llamaTabBtn = document.getElementById("llamaTabBtn");
  const tabPanels = {
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
  let currentTab = "load";
  let llamaSnapshotsLedger = null;
  let llamaEventsLedger = null;
  let ledgerConnection = null; // { dataDirHandle, campaignKey, lastModified } while auto-connected
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
  // PVP (default) scores player-vs-player wars, same as always. PVE scores
  // the SAME wars/formula but for the opposite isPvP split - a player's
  // performance against AI - which doubles as a live sanity-check of the
  // PVP scoring logic itself (see js/llama-score.js's module comment on
  // computeLlamaScores' mode param). Persisted so reloading the page keeps
  // whichever mode was last selected.
  const LLAMA_MODE_KEY = "eu5-analyzer-llama-mode";
  let llamaScoreMode = localStorage.getItem(LLAMA_MODE_KEY) === "pve" ? "pve" : "pvp";
  // Set when the page loads with a ?save=<id> URL that isn't in this
  // browser's local history yet - see initFromShareUrl()/onParsed().
  let pendingShareId = null;
  let pendingShareTab = "metrics";

  function activateTab(tab) {
    currentTab = tab;
    document.body.classList.toggle("map-view-active", tab === "map");
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

  countryMetricTabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      currentMetricGroup = btn.dataset.metrics || "key";
      countryMetricTabs.forEach((b) => b.classList.toggle("active", b === btn));
      drawCountryTable();
    });
  });

  playerMetricTabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      currentPlayerMetricGroup = btn.dataset.metrics || "key";
      playerMetricTabs.forEach((b) => b.classList.toggle("active", b === btn));
      drawPlayerTable();
    });
  });

  // Manual exclude list for players who've left the campaign for good. The
  // save has no "still connected" flag (it's a snapshot of game state, not
  // a live session roster) - a departed player still shows as the country's
  // last controller same as anyone else, so there's no reliable way to
  // auto-detect "gone and not coming back" from the save data alone. This
  // is a deliberate manual override instead of a guess.
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
      worker = new Worker("js/parse-worker.js");
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
    if (options.persist === false && result.__schemaVersion !== RESULT_SCHEMA_VERSION) {
      showError(
        `This save was loaded from your local save history, saved by an older version of this analyzer - some data (e.g. Black Death) may be missing or wrong until it's re-parsed. ` +
          `<button type="button" id="staleCacheRemoveBtn" class="link-btn">Remove from history</button> and re-upload the original <code>.eu5</code> file to refresh it.`
      );
      const removeBtn = document.getElementById("staleCacheRemoveBtn");
      if (removeBtn) removeBtn.addEventListener("click", () => removeStaleLibraryEntry(options.libraryId));
    } else {
      errorBox.hidden = true;
    }

    latestResult = result;
    mapRenderedForResult = false;
    setResultTabsAvailable(true);
    if (wasOnLoadTab) activateTab("metrics");
    // Derived metrics (profit, efficiency, per-pop ratios) are read by both
    // the countries table and the players table - compute once, before
    // either renders, rather than only inside renderCountries() (which used
    // to run after renderPlayers(), so player rows briefly/always read
    // undefined for these).
    result.countries.forEach((c) => {
      c.__isPlayerCountry = c.players && c.players.length > 0;
      computeDerivedMetrics(c);
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
    if (options.persist !== false) saveResultToLibrary(displayName, result);

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
    const excluded = getExcludedPlayers();
    return result.players.filter((p) => !excluded.has(p.name) && p.country);
  }

  function renderTrends(result) {
    if (typeof Charts === "undefined") return;
    const players = visiblePlayers(result);
    const withHistory = players.filter((p) => Array.isArray(p.country.historicalPopulation) && p.country.historicalPopulation.length);
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
        title: "Tax base / population over time",
        years,
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

  // Green (least population lost, "won" against the plague) to red (most
  // lost) - scaled relative to THIS save's own min/max (set by
  // renderBlackDeath below) rather than a fixed 0-100% axis, since real
  // per-country tallies cluster in a fairly narrow band (e.g. 20-40%) that
  // would otherwise all read as a near-identical color against the full
  // range.
  const LOSS_PCT_GOOD_RGB = [111, 207, 151]; // --good
  const LOSS_PCT_BAD_RGB = [235, 87, 87]; // --bad
  let blackDeathLossRange = { min: 0, max: 1 };
  function lossPctColor(pct) {
    const { min, max } = blackDeathLossRange;
    const span = max - min;
    const t = span > 0 ? Math.max(0, Math.min(1, (pct - min) / span)) : 0;
    const rgb = LOSS_PCT_GOOD_RGB.map((g, i) => Math.round(g + (LOSS_PCT_BAD_RGB[i] - g) * t));
    return `rgb(${rgb.join(",")})`;
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
      render: (c) =>
        typeof c.popLossPct === "number"
          ? `<span style="color:${lossPctColor(c.popLossPct)}; font-weight:600;">${(c.popLossPct * 100).toFixed(1)}%</span>`
          : "-",
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

    const lossValues = rows.map((r) => r.popLossPct).filter((v) => typeof v === "number");
    blackDeathLossRange = lossValues.length ? { min: Math.min(...lossValues), max: Math.max(...lossValues) } : { min: 0, max: 1 };

    renderSortableTable(blackDeathTableEl, rows, BLACK_DEATH_COLUMNS, { defaultSortKey: "popLossPct" });
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
    "player-departed": "Auto-excluded: this player was no longer controlling this country by the time the war ended (recorder saw the country revert to AI). Uncheck to score it anyway.",
    "opponent-departed": "Auto-excluded: every enemy in this war had already left the campaign by its end (fighting an abandoned country doesn't score). Uncheck to score it anyway.",
    "player-hidden": "Auto-excluded: you've hidden this player in the Players table (Hide button) as departed - unhide them there to include their wars again.",
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
    "post-war-land-transfer": "Land changed hands (clean 1-on-1 data)",
    "post-war-land-transfer-coalition": "Land changed hands (coalition-wide - less certain)",
    "post-war-treasury-swing": "Treasury swung between sides",
    "post-war-treasury-gain": "One side gained a lot of gold",
    "post-war-prestige-swing": "Prestige swung between sides",
    "battle-losses-inflicted": "Battle losses (no economic signal)",
    "last-known-war-score": "Last known in-game war score",
    "last-known-single-sided-attacker-score": "Leftover one-sided war score (attacker)",
    "last-known-single-sided-defender-score": "Leftover one-sided war score (defender)",
    "white-peace": "No decisive signal - treated as white peace",
    "war-disappeared-without-decisive-signal": "No signal before the war disappeared",
  };
  // Hover tooltips for the less-obvious reason codes - see the "How are
  // these scores calculated?" details block above for the full writeup.
  const LLAMA_REASON_TOOLTIPS = {
    "last-known-single-sided-attacker-score":
      "EU5 normally clears both sides' war score together when a war ends - occasionally only one side's value survives. That lone leftover number is a last-resort, low-confidence guess used only when nothing more direct is available.",
    "last-known-single-sided-defender-score":
      "EU5 normally clears both sides' war score together when a war ends - occasionally only one side's value survives. That lone leftover number is a last-resort, low-confidence guess used only when nothing more direct is available.",
    "post-war-land-transfer-coalition":
      "Land changed hands, but only measured across the whole side (including any vassals/allies dragged in) rather than just the war's original two declared belligerents - a real signal, just less precise than a clean 1-on-1 comparison.",
  };
  function renderLlamaReason(w) {
    const label = LLAMA_REASON_LABELS[w.reason] || w.reason || "Unknown";
    const tooltip = LLAMA_REASON_TOOLTIPS[w.reason] || "";
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
    if (!leaderboard.length) {
      leaderboardEl.innerHTML = '<p class="panel-note">No players found.</p>';
      return;
    }
    leaderboardEl.innerHTML = '<div id="llamaLeaderboardChart"></div>';
    // PVE's points are relabeled "Alpaca Points" per the user's request -
    // same underlying computation/formula (llamaPoints field, unchanged) as
    // PVP's "Llama Points", just a different name so the two are never
    // confused for the same leaderboard at a glance.
    Charts.renderStackedBarChart(document.getElementById("llamaLeaderboardChart"), {
      title: llamaScoreMode === "pve" ? "Alpaca Points" : "Llama Points",
      items: leaderboard.map((l) => ({
        label: `${l.player} (${l.countryTag || "?"})`,
        player: l.player,
        countryTag: l.countryTag,
        total: Math.round((l.llamaPoints || 0) * 100) / 100,
        segments: [
          { label: "GP contribution", color: "#5b9dd9", value: Math.round(((l.gpScore || 0) / 100) * 100) / 100 },
          { label: "War contribution", color: "#6fcf97", value: Math.round((l.vpPositive || 0) * 100) / 100 },
          { label: "Negative war score", color: "#eb5757", value: Math.round((l.vpNegative || 0) * 100) / 100 },
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
        getExcludedPlayers(),
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

  // The panel is hidden by default and only shown automatically once real
  // ledger data is actually on screen (auto-linked, manually connected, or
  // manually file-picked) - a save with no matching recorder output showing
  // an empty/near-empty panel every time was more clutter than signal. The
  // checkbox is the escape hatch for "I know there's nothing auto-linked,
  // show me the manual tools/per-save fallback anyway."
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
  llamaShowToggleEl.checked = localStorage.getItem(LLAMA_SHOW_TOGGLE_KEY) === "1";

  function loadLlamaLedgerFile(file, kind) {
    file.text().then((text) => {
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
      llamaAutoStatusEl.textContent = "Auto-linking needs a Chromium-based browser (Chrome/Edge) - use Manual setup below instead.";
      updateLlamaPanelVisibility();
      return;
    }
    const key = campaignKeyFromFilename(currentSaveDisplayName);
    if (!key) {
      llamaAutoStatusEl.textContent = "This save's filename doesn't look like a recorder-watched autosave - use Manual setup below to load its data.";
      updateLlamaPanelVisibility();
      return;
    }
    const handle = (ledgerConnection && ledgerConnection.dataDirHandle) || (await LedgerConnect.loadHandle());
    if (!handle) {
      llamaAutoStatusEl.textContent = "No recorder folder connected yet - see Manual setup below.";
      updateLlamaPanelVisibility();
      return;
    }
    const granted = await LedgerConnect.verifyPermission(handle, false);
    if (!granted) {
      llamaAutoStatusEl.textContent = "Recorder folder was connected previously but needs re-granting - see Manual setup below.";
      llamaConnectBtn.hidden = false;
      llamaConnectBtn.textContent = "Reconnect campaign folder…";
      llamaConnectBtn.dataset.pending = "1";
      updateLlamaPanelVisibility();
      return;
    }
    const best = await LedgerConnect.findCampaignByKey(handle, key);
    if (!best) {
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
      Charts.renderLineChart(inner, {
        title: config.title,
        years: years.slice(start, end + 1),
        series: config.series.map((s) => ({ ...s, points: (s.points || []).slice(start, end + 1) })),
      });
    }

    startInput.addEventListener("input", draw);
    endInput.addEventListener("input", draw);
    draw();
  }

  function renderMap(result) {
    if (typeof MapView === "undefined") return;
    mapRenderedForResult = true;
    mapContainerEl.innerHTML = '<div class="map-loading">Loading map...</div>';
    MapView.createMapView(mapContainerEl, result).catch((err) => {
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

  function fmtPopulation(raw) {
    if (raw === undefined || raw === null || Number.isNaN(raw)) return "-";
    return Math.round(Number(raw) * 1000).toLocaleString();
  }

  function renderOverview(result) {
    const meta = result.metadata || {};
    const realCountries = result.countries.filter((c) => c.countryType === "Real");
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
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

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
    { key: "profit", label: "Profit", numeric: true, render: (c) => fmtNum(c.profit, 1) },
    {
      key: "efficiency",
      label: "Profit Efficiency",
      numeric: true,
      render: (c) => (typeof c.efficiency === "number" ? (c.efficiency * 100).toFixed(0) + "%" : "-"),
    },
    { key: "lastMonthsArmyMaintenance", label: "Army Upkeep", numeric: true, render: (c) => fmtNum(c.lastMonthsArmyMaintenance, 2) },
    { key: "lastMonthsNavyMaintenance", label: "Navy Upkeep", numeric: true, render: (c) => fmtNum(c.lastMonthsNavyMaintenance, 2) },
    { key: "manpower", label: "Manpower", numeric: true, render: (c) => fmtNum(c.manpower, 2) },
    { key: "sailors", label: "Sailors", numeric: true, render: (c) => fmtNum(c.sailors, 2) },
    { key: "expectedArmySize", label: "Army Size", numeric: true, render: (c) => fmtNum(c.expectedArmySize, 2) },
    { key: "expectedNavySize", label: "Navy Size", numeric: true, render: (c) => fmtNum(c.expectedNavySize, 0) },
    { key: "population", label: "Population (people)", numeric: true, render: (c) => fmtPopulation(c.population) },
    { key: "incomePerPop", label: "Income/1k people", numeric: true, render: (c) => fmtNum(c.incomePerPop, 3) },
    { key: "taxBasePerPop", label: "Tax Base/1k people", numeric: true, render: (c) => fmtNum(c.taxBasePerPop, 3) },
    { key: "manpowerPerPop", label: "Manpower/1k people", numeric: true, render: (c) => fmtNum(c.manpowerPerPop, 3) },
    { key: "stability", label: "Stability", numeric: true, render: (c) => fmtNum(c.stability, 1) },
    { key: "prestige", label: "Prestige", numeric: true, render: (c) => fmtNum(c.prestige, 1) },
    { key: "greatPowerRank", label: "GP Rank", numeric: true, render: (c) => fmtNum(c.greatPowerRank, 0) },
  ];

  const PLAYER_COLUMNS = [
    { key: "name", label: "Player", render: (p) => escapeHtml(p.name || "-") },
    { key: "tag", label: "Tag", render: (p) => `<span class="tag-badge">${escapeHtml((p.country && p.country.tag) || "?")}</span>` },
    { key: "governmentType", label: "Government", render: (p) => escapeHtml((p.country && p.country.governmentType) || "-") },
    { key: "scorePlace", label: "Rank", numeric: true, render: (p) => fmtNum(p.country && p.country.scorePlace, 0) },
    { key: "locationCount", label: "Locations", numeric: true, render: (p) => fmtNum(p.country && p.country.locationCount, 0) },
    { key: "totalDevelopment", label: "Development", numeric: true, render: (p) => fmtNum(p.country && p.country.totalDevelopment, 1) },
    { key: "avgDevelopment", label: "Avg Dev/location", numeric: true, render: (p) => fmtNum(p.country && p.country.avgDevelopment, 2) },
    { key: "gold", label: "Treasury", numeric: true, render: (p) => fmtNum(p.country && p.country.gold, 1) },
    { key: "lastMonthGoldIncome", label: "Income/mo", numeric: true, render: (p) => fmtNum(p.country && p.country.lastMonthGoldIncome, 2) },
    { key: "profit", label: "Profit", numeric: true, render: (p) => fmtNum(p.country && p.country.profit, 1) },
    {
      key: "efficiency",
      label: "Profit Efficiency",
      numeric: true,
      render: (p) => (p.country && typeof p.country.efficiency === "number" ? (p.country.efficiency * 100).toFixed(0) + "%" : "-"),
    },
    { key: "population", label: "Population (people)", numeric: true, render: (p) => fmtPopulation(p.country && p.country.population) },
    { key: "incomePerPop", label: "Income/1k people", numeric: true, render: (p) => fmtNum(p.country && p.country.incomePerPop, 3) },
    { key: "taxBasePerPop", label: "Tax Base/1k people", numeric: true, render: (p) => fmtNum(p.country && p.country.taxBasePerPop, 3) },
    { key: "manpower", label: "Manpower", numeric: true, render: (p) => fmtNum(p.country && p.country.manpower, 2) },
    { key: "manpowerPerPop", label: "Manpower/1k people", numeric: true, render: (p) => fmtNum(p.country && p.country.manpowerPerPop, 3) },
    { key: "sailors", label: "Sailors", numeric: true, render: (p) => fmtNum(p.country && p.country.sailors, 2) },
    { key: "expectedArmySize", label: "Army Size", numeric: true, render: (p) => fmtNum(p.country && p.country.expectedArmySize, 2) },
    { key: "expectedNavySize", label: "Navy Size", numeric: true, render: (p) => fmtNum(p.country && p.country.expectedNavySize, 0) },
    { key: "admScore", label: "ADM", numeric: true, render: (p) => fmtNum(p.country && p.country.admScore, 2) },
    { key: "dipScore", label: "DIP", numeric: true, render: (p) => fmtNum(p.country && p.country.dipScore, 2) },
    { key: "milScore", label: "MIL", numeric: true, render: (p) => fmtNum(p.country && p.country.milScore, 2) },
    { key: "stability", label: "Stability", numeric: true, render: (p) => fmtNum(p.country && p.country.stability, 1) },
    { key: "prestige", label: "Prestige", numeric: true, render: (p) => fmtNum(p.country && p.country.prestige, 1) },
    { key: "greatPowerRank", label: "GP Rank", numeric: true, render: (p) => fmtNum(p.country && p.country.greatPowerRank, 0) },
    {
      key: "__hide",
      label: "",
      render: (p) => `<button class="hide-player-btn" data-name="${escapeHtml(p.name || "")}" title="Hide this player (they left the campaign)">Hide</button>`,
    },
  ];

  const PLAYER_COUNTRY_SORT_KEYS = [
    "scorePlace",
    "locationCount",
    "totalDevelopment",
    "avgDevelopment",
    "gold",
    "lastMonthGoldIncome",
    "profit",
    "efficiency",
    "population",
    "incomePerPop",
    "taxBasePerPop",
    "manpowerPerPop",
    "manpower",
    "sailors",
    "expectedArmySize",
    "expectedNavySize",
    "admScore",
    "dipScore",
    "milScore",
    "stability",
    "prestige",
    "greatPowerRank",
  ];

  const COUNTRY_METRIC_GROUPS = {
    key: ["tag", "playerNames", "lastMonthGoldIncome", "profit", "efficiency", "population", "manpowerPerPop"],
    economy: [
      "tag",
      "playerNames",
      "gold",
      "lastMonthGoldIncome",
      "income",
      "expense",
      "profit",
      "efficiency",
      "lastMonthsArmyMaintenance",
      "lastMonthsNavyMaintenance",
      "incomePerPop",
      "taxBasePerPop",
    ],
    military: ["tag", "playerNames", "scorePlace", "manpower", "manpowerPerPop", "sailors", "expectedArmySize", "expectedNavySize", "admScore", "dipScore", "milScore"],
    demographic: [
      "tag",
      "playerNames",
      "locationCount",
      "totalDevelopment",
      "avgDevelopment",
      "population",
      "incomePerPop",
      "taxBasePerPop",
      "manpowerPerPop",
      "stability",
      "prestige",
      "greatPowerRank",
    ],
  };

  const PLAYER_METRIC_GROUPS = {
    key: ["name", "tag", "lastMonthGoldIncome", "profit", "efficiency", "population", "manpowerPerPop", "__hide"],
    economy: ["name", "tag", "gold", "lastMonthGoldIncome", "profit", "efficiency", "incomePerPop", "taxBasePerPop", "__hide"],
    military: ["name", "tag", "scorePlace", "manpower", "manpowerPerPop", "sailors", "expectedArmySize", "expectedNavySize", "admScore", "dipScore", "milScore", "__hide"],
    demographic: ["name", "tag", "locationCount", "totalDevelopment", "avgDevelopment", "population", "incomePerPop", "taxBasePerPop", "stability", "prestige", "greatPowerRank", "__hide"],
  };

  function countryColumnsForCurrentGroup() {
    const keys = COUNTRY_METRIC_GROUPS[currentMetricGroup] || COUNTRY_METRIC_GROUPS.key;
    return keys.map((key) => COUNTRY_COLUMNS.find((col) => col.key === key)).filter(Boolean);
  }

  function playerColumnsForCurrentGroup() {
    const keys = PLAYER_METRIC_GROUPS[currentPlayerMetricGroup] || PLAYER_METRIC_GROUPS.key;
    return keys.map((key) => PLAYER_COLUMNS.find((col) => col.key === key)).filter(Boolean);
  }

  function sortValue(row, col) {
    if (!col) return undefined;
    if (col.key === "tag" && row.country) return row.country.tag;
    if (PLAYER_COUNTRY_SORT_KEYS.includes(col.key) && row.country) {
      return row.country[col.key];
    }
    return row[col.key];
  }

  const KEY_HEAT_COLUMNS = new Set(["lastMonthGoldIncome", "profit", "efficiency", "population", "manpowerPerPop"]);

  function metricValue(row, col) {
    const value = sortValue(row, col);
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }

  function renderSortableTable(container, rows, columns, options) {
    options = options || {};
    let sortKey = options.defaultSortKey || (columns[0] && columns[0].key);
    let sortDir = -1;

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
          return `<th data-key="${col.key}" class="${isSorted ? "sorted" : ""}">${escapeHtml(col.label)}${arrow}</th>`;
        })
        .join("");

      const tbody = sorted
        .map((row) => {
          const cells = columns
            .map((col) => {
              const classes = [col.numeric ? "num" : ""];
              let style = "";
              if (options.colorKeyMetrics && KEY_HEAT_COLUMNS.has(col.key)) {
                const value = metricValue(row, col);
                const values = rows.map((r) => metricValue(r, col)).filter((v) => typeof v === "number");
                const min = values.length ? Math.min(...values) : undefined;
                const max = values.length ? Math.max(...values) : undefined;
                if (typeof value === "number" && typeof min === "number" && typeof max === "number" && max > min) {
                  const score = Math.max(0, Math.min(1, (value - min) / (max - min)));
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

      container.innerHTML = `<table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`;

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
      });
    }

    const columns = playerColumnsForCurrentGroup();
    renderSortableTable(playersTableEl, visible, columns, {
      defaultSortKey: columns.some((col) => col.key === "scorePlace") ? "scorePlace" : columns[0] && columns[0].key,
      colorKeyMetrics: currentPlayerMetricGroup === "key",
      onRender: (container) => {
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
    c.latestTaxBase = Array.isArray(c.historicalTaxBase) && c.historicalTaxBase.length ? c.historicalTaxBase[c.historicalTaxBase.length - 1] : undefined;
    c.incomePerPop = typeof c.lastMonthGoldIncome === "number" && c.population > 0 ? c.lastMonthGoldIncome / c.population : undefined;
    c.taxBasePerPop = typeof c.latestTaxBase === "number" && c.population > 0 ? c.latestTaxBase / c.population : undefined;
    c.manpowerPerPop = typeof c.manpower === "number" && c.population > 0 ? c.manpower / c.population : undefined;
  }

  function computeCountryLocationMetrics(result) {
    const byCountry = new Map((result.countries || []).map((c) => [c.number, c]));
    const totals = new Map();
    for (const loc of result.locations || []) {
      if (!loc || typeof loc.owner !== "number") continue;
      const row = totals.get(loc.owner) || { development: 0, locations: 0 };
      if (typeof loc.development === "number") row.development += loc.development;
      row.locations += 1;
      totals.set(loc.owner, row);
    }
    for (const [countryNumber, row] of totals.entries()) {
      const country = byCountry.get(countryNumber);
      if (!country) continue;
      country.totalDevelopment = row.development;
      country.avgDevelopment = row.locations > 0 ? row.development / row.locations : undefined;
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
    const columns = countryColumnsForCurrentGroup();
    const defaultSortKey = columns.some((col) => col.key === "scorePlace") ? "scorePlace" : columns[0] && columns[0].key;
    countriesController = renderSortableTable(countriesTableEl, filteredCountries(), columns, {
      defaultSortKey,
      colorKeyMetrics: currentMetricGroup === "key",
    });
  }

  function renderCountries(result) {
    latestCountries = result.countries.filter((c) => c.countryType === "Real");
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
  const RESULT_SCHEMA_VERSION = 3;

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
  // Fully client-side, no server (see README): a link can't hand a save's
  // data to someone who's never uploaded it. What it CAN do is carry a
  // stable save id + tab so reloading, bookmarking, or re-opening a link on
  // a browser that already has that save (via the local history above)
  // restores the exact view instead of resetting to a blank uploader - the
  // behavior this was built to fix.

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
    if (typeof SaveLibrary === "undefined" || !SaveLibrary.available) {
      showPendingShareNotice(id);
      return;
    }
    SaveLibrary.get(id).then((record) => {
      if (record) {
        onParsed(record.result, { persist: false, displayName: record.fileName });
        activateTab(pendingShareTab);
      } else {
        pendingShareId = id;
        showPendingShareNotice(id);
      }
    });
  }

  copyLinkBtn.addEventListener("click", () => {
    if (!latestResult || !navigator.clipboard) return;
    updateShareUrl();
    navigator.clipboard
      .writeText(location.href)
      .then(() => {
        const original = copyLinkBtn.textContent;
        copyLinkBtn.textContent = "Copied!";
        setTimeout(() => {
          copyLinkBtn.textContent = original;
        }, 1500);
      })
      .catch(() => {});
  });

  updateLlamaPanelVisibility();
  initFromShareUrl();
  refreshSavesLibraryUI();
  tryAutoReconnect();
})();
