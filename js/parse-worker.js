// Runs the (potentially multi-second) save parse off the main thread so the
// page stays responsive on large files. Handles both melted (plaintext) and
// compressed (binary-tokenized) EU5 saves.
const WORKER_ASSET_VERSION = "v1.3.8";
importScripts(
  `clausewitz.js?v=${WORKER_ASSET_VERSION}`,
  `eu5-fixed-ids.js?v=${WORKER_ASSET_VERSION}`,
  `clausewitz-binary.js?v=${WORKER_ASSET_VERSION}`
);

self.onmessage = async (event) => {
  const file = event.data.file;
  try {
    const header = await file.slice(0, 7).text();
    if (!header.startsWith("SAV")) throw new Error("Not an EU5 save file (missing SAV header).");
    const formatCode = header.slice(5, 7);

    let result;
    if (formatCode === "00") {
      self.postMessage({ type: "status", message: "Reading file..." });
      const text = await file.text();
      self.postMessage({ type: "status", message: "Parsing save..." });
      result = Clausewitz.parseSave(text, {
        includeLocations: true,
        includeWars: true,
        onProgress: (frac) => self.postMessage({ type: "progress", fraction: frac }),
      });
    } else if (formatCode === "03") {
      self.postMessage({ type: "status", message: "Reading file..." });
      const arrayBuffer = await file.arrayBuffer();
      self.postMessage({ type: "status", message: "Melting save..." });
      result = await ClausewitzBinary.parseCompressedSave(arrayBuffer, {
        includeLocations: true,
        includeWars: true,
        onProgress: (frac) => self.postMessage({ type: "progress", fraction: frac }),
      });
    } else {
      throw new Error(`Unrecognized save format code "${formatCode}".`);
    }

    // Map isn't needed on the main thread; plain objects/arrays are enough
    // and keep the postMessage payload straightforward.
    self.postMessage({
      type: "done",
      result: {
        metadata: result.metadata,
        countries: result.countries,
        players: result.players,
        playerSessions: result.playerSessions,
        locations: result.locations,
        popRecords: result.popRecords,
        estateTradeIncomes: result.estateTradeIncomes,
        armySubunitDetails: result.armySubunitDetails,
        dependencies: result.dependencies,
        cultures: result.cultures,
        religions: result.religions,
        markets: result.markets,
        tradeRoutes: result.tradeRoutes,
        buildings: result.buildings,
        wars: result.wars,
        blackDeath: result.blackDeath,
        provinceOwnerByDefinition: result.provinceOwnerByDefinition,
        // Non-null means the binary parser had to bail out of the gamestate
        // scan early (see parseCompressedSave's catch block) - the result
        // above may be silently missing players/wars/locations despite
        // looking otherwise normal. Not surfaced in the UI yet; at minimum
        // it's no longer only visible in a browser console no one is
        // watching.
        parseWarning: result.parseWarning || null,
      },
    });
  } catch (err) {
    self.postMessage({ type: "error", message: err && err.message ? err.message : String(err) });
  }
};
