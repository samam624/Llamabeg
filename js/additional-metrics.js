(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AdditionalMetrics = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function finiteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function indexByNumber(rows) {
    const map = new Map();
    for (const row of rows || []) {
      if (row && finiteNumber(row.number)) map.set(row.number, row);
    }
    return map;
  }

  // EU5 stores literacy on individual pop-manager records. This is the
  // population-weighted literacy of all pops owned by a country (and, for
  // the map data model, of all pops in each location). The save's literacy
  // unit is already percentage points: 38 means 38%, not 0.38.
  function applyLiteracy(result) {
    const countries = indexByNumber(result && result.countries);
    const pops = indexByNumber(result && result.popRecords);
    const countryTotals = new Map();
    for (const country of countries.values()) delete country.literacy;

    for (const loc of (result && result.locations) || []) {
      if (!loc) continue;
      let weighted = 0;
      let population = 0;
      for (const popId of loc.popIds || []) {
        const pop = pops.get(popId);
        if (!pop || !finiteNumber(pop.literacy) || !finiteNumber(pop.size) || pop.size <= 0) continue;
        weighted += pop.literacy * pop.size;
        population += pop.size;
      }
      if (population > 0) {
        loc.literacy = weighted / population;
        if (finiteNumber(loc.owner) && countries.has(loc.owner)) {
          if (!countryTotals.has(loc.owner)) countryTotals.set(loc.owner, { weighted: 0, population: 0 });
          const total = countryTotals.get(loc.owner);
          total.weighted += weighted;
          total.population += population;
        }
      } else {
        delete loc.literacy;
      }
    }
    for (const [countryId, total] of countryTotals) countries.get(countryId).literacy = total.weighted / total.population;
  }

  // Each market has one compact merchant row per participating country.
  // Capacity is country-specific but market-scoped, so the national figure
  // shown by the game is the sum of that country's capacity across markets.
  function applyTradeCapacity(result) {
    const countries = indexByNumber(result && result.countries);
    const markets = (result && result.markets) || [];
    for (const country of countries.values()) {
      delete country.tradeCapacity;
      delete country.usedTradeCapacity;
    }
    if (!markets.length) return;
    for (const country of countries.values()) {
      country.tradeCapacity = 0;
      country.usedTradeCapacity = 0;
    }
    for (const market of markets) {
      for (const merchant of (market && market.merchants) || []) {
        const country = countries.get(merchant && merchant.country);
        if (!country) continue;
        if (finiteNumber(merchant.capacity)) country.tradeCapacity += merchant.capacity;
        if (finiteNumber(merchant.used)) country.usedTradeCapacity += merchant.used;
      }
    }
  }

  function marketPrice(market, good) {
    const row = market && market.goods && market.goods[good];
    return row && finiteNumber(row.price) && row.price > 0 ? row.price : null;
  }

  function productionEfficiencyForBuilding(building, loc, market, definitions) {
    if (
      !building ||
      !loc ||
      !market ||
      !definitions ||
      !definitions.methods ||
      !finiteNumber(building.lastMonthsProfit) ||
      !finiteNumber(building.employed) ||
      building.employed <= 0 ||
      !finiteNumber(building.level) ||
      building.level <= 0 ||
      !Array.isArray(building.productionMethods) ||
      !building.productionMethods.length
    ) return null;

    // EU5's last_months_profit is normalized to fully staffed active levels,
    // even when the building is only partly staffed. Current goods flow in
    // the UI is employment-scaled, but comparing that smaller flow directly
    // to the normalized save value makes under-employed buildings look
    // hundreds of percent efficient (Lavenham's 116/1,000 Charcoal Kiln was
    // the real-save proof: +298.10% inferred versus +18.35% in game). Work on
    // the same full-active-level basis as the saved profit instead.
    //
    // Input-shortage records describe the current demand snapshot, whereas
    // profit is last month's normalized value. They cannot safely be mixed:
    // doing so made Shaharah's nearly unfulfilled Market Village resolve to
    // +416.93%. Exclude shortage-affected buildings until both values exist
    // on the same basis rather than publishing a fabricated modifier.
    const hasShortage = building.productionMethods.some((active) =>
      Object.values((active && active.shortages) || {}).some((amount) => finiteNumber(amount) && amount > 0)
    );
    if (hasShortage) return null;

    const access = finiteNumber(loc.marketAccess) ? Math.max(0, loc.marketAccess) : 1;
    const scale = building.level * access;
    if (!(scale > 0)) return null;

    let inputCost = 0;
    let baseGross = 0;
    let resolvedMethods = 0;
    for (const active of building.productionMethods) {
      const method = active && definitions.methods[active.key];
      if (!method) continue; // upkeep-only demands intentionally have no output definition
      const outputPrice = marketPrice(market, method.produced);
      if (outputPrice === null) continue;

      let fullInputCost = 0;
      let complete = true;
      for (const [good, amount] of Object.entries(method.inputs || {})) {
        const price = marketPrice(market, good);
        if (price === null || !finiteNumber(amount)) {
          complete = false;
          break;
        }
        fullInputCost += amount * scale * price;
      }
      if (!complete || !(fullInputCost > 0)) continue;
      inputCost += fullInputCost;
      baseGross += method.output * scale * outputPrice;
      resolvedMethods++;
    }
    if (!resolvedMethods || !(baseGross > 0)) return null;
    const efficiency = (building.lastMonthsProfit + inputCost) / baseGross - 1;
    // A multiplier below zero is impossible; a tiny tolerance absorbs save
    // rounding. The broad upper guard prevents a missing/mismatched method
    // definition from dominating an entire national average.
    if (!Number.isFinite(efficiency) || efficiency < -1.01 || efficiency > 10) return null;
    return efficiency;
  }

  function productionEfficiencySettlementGroup(loc) {
    if (!loc) return null;
    if (loc.rank === "rural_settlement") return "Rural";
    if (loc.rank === "town" || loc.rank === "city" || loc.rank === "megalopolis") return "Urban";
    return null;
  }

  function addWeightedEfficiency(totals, id, efficiency, weight) {
    if (!totals.has(id)) totals.set(id, { weighted: 0, levels: 0, samples: 0 });
    const total = totals.get(id);
    total.weighted += efficiency * weight;
    total.levels += weight;
    total.samples++;
  }

  function assignAverageEfficiency(row, prefix, total) {
    row[`average${prefix}BuildingProductionEfficiency`] = total.weighted / total.levels;
    row[`${prefix.charAt(0).toLowerCase() + prefix.slice(1)}BuildingProductionEfficiencySamples`] = total.samples;
    row[`${prefix.charAt(0).toLowerCase() + prefix.slice(1)}BuildingProductionEfficiencyLevels`] = total.levels;
  }

  function applyProductionEfficiency(result, definitions) {
    const countries = indexByNumber(result && result.countries);
    const locations = indexByNumber(result && result.locations);
    const markets = indexByNumber(result && result.markets);
    const locationTotals = new Map();
    const countryTotals = new Map();
    const ruralLocationTotals = new Map();
    const urbanLocationTotals = new Map();
    const ruralCountryTotals = new Map();
    const urbanCountryTotals = new Map();

    for (const country of countries.values()) {
      delete country.averageBuildingProductionEfficiency;
      delete country.buildingProductionEfficiencySamples;
      delete country.buildingProductionEfficiencyLevels;
      delete country.averageRuralBuildingProductionEfficiency;
      delete country.ruralBuildingProductionEfficiencySamples;
      delete country.ruralBuildingProductionEfficiencyLevels;
      delete country.averageUrbanBuildingProductionEfficiency;
      delete country.urbanBuildingProductionEfficiencySamples;
      delete country.urbanBuildingProductionEfficiencyLevels;
    }
    for (const loc of locations.values()) {
      delete loc.averageBuildingProductionEfficiency;
      delete loc.buildingProductionEfficiencySamples;
      delete loc.buildingProductionEfficiencyLevels;
      delete loc.averageRuralBuildingProductionEfficiency;
      delete loc.ruralBuildingProductionEfficiencySamples;
      delete loc.ruralBuildingProductionEfficiencyLevels;
      delete loc.averageUrbanBuildingProductionEfficiency;
      delete loc.urbanBuildingProductionEfficiencySamples;
      delete loc.urbanBuildingProductionEfficiencyLevels;
    }

    let resolvedBuildings = 0;
    for (const building of (result && result.buildings) || []) {
      if (!building || !finiteNumber(building.location)) continue;
      const loc = locations.get(building.location);
      const market = loc && markets.get(loc.market);
      const efficiency = productionEfficiencyForBuilding(building, loc, market, definitions);
      if (efficiency === null) {
        delete building.productionEfficiency;
        continue;
      }
      building.productionEfficiency = efficiency;
      const weight = finiteNumber(building.level) && building.level > 0 ? building.level : 1;
      addWeightedEfficiency(locationTotals, loc.number, efficiency, weight);
      const settlementGroup = productionEfficiencySettlementGroup(loc);
      const groupedLocationTotals = settlementGroup === "Rural" ? ruralLocationTotals : settlementGroup === "Urban" ? urbanLocationTotals : null;
      if (groupedLocationTotals) addWeightedEfficiency(groupedLocationTotals, loc.number, efficiency, weight);
      const countryId = finiteNumber(building.owner) && countries.has(building.owner) ? building.owner : loc.owner;
      if (finiteNumber(countryId) && countries.has(countryId)) {
        addWeightedEfficiency(countryTotals, countryId, efficiency, weight);
        const groupedCountryTotals = settlementGroup === "Rural" ? ruralCountryTotals : settlementGroup === "Urban" ? urbanCountryTotals : null;
        if (groupedCountryTotals) addWeightedEfficiency(groupedCountryTotals, countryId, efficiency, weight);
      }
      resolvedBuildings++;
    }

    for (const [locId, total] of locationTotals) {
      const loc = locations.get(locId);
      loc.averageBuildingProductionEfficiency = total.weighted / total.levels;
      loc.buildingProductionEfficiencySamples = total.samples;
      loc.buildingProductionEfficiencyLevels = total.levels;
    }
    for (const [locId, total] of ruralLocationTotals) assignAverageEfficiency(locations.get(locId), "Rural", total);
    for (const [locId, total] of urbanLocationTotals) assignAverageEfficiency(locations.get(locId), "Urban", total);
    for (const [countryId, total] of countryTotals) {
      const country = countries.get(countryId);
      country.averageBuildingProductionEfficiency = total.weighted / total.levels;
      country.buildingProductionEfficiencySamples = total.samples;
      country.buildingProductionEfficiencyLevels = total.levels;
    }
    for (const [countryId, total] of ruralCountryTotals) assignAverageEfficiency(countries.get(countryId), "Rural", total);
    for (const [countryId, total] of urbanCountryTotals) assignAverageEfficiency(countries.get(countryId), "Urban", total);
    return {
      resolvedBuildings,
      locations: locationTotals.size,
      countries: countryTotals.size,
      ruralLocations: ruralLocationTotals.size,
      urbanLocations: urbanLocationTotals.size,
      ruralCountries: ruralCountryTotals.size,
      urbanCountries: urbanCountryTotals.size,
    };
  }

  function applySaveBackedMetrics(result) {
    applyLiteracy(result);
    applyTradeCapacity(result);
  }

  return {
    applyLiteracy,
    applyTradeCapacity,
    applyProductionEfficiency,
    applySaveBackedMetrics,
    productionEfficiencyForBuilding,
    productionEfficiencySettlementGroup,
  };
});
