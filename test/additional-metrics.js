const assert = require("assert");
const Clausewitz = require("../js/clausewitz.js");
const AdditionalMetrics = require("../js/additional-metrics.js");

const extracted = Clausewitz.extractBuildingFields(7, {
  type: "printing_press_shop",
  level: 46,
  employed: 4.6,
  location: 100,
  owner: 3,
  last_months_profit: 54,
  printing_press_maintenance: {
    missing: { demand: "printing_press_maintenance", paper: 1.25 },
  },
});
assert.deepStrictEqual(extracted.productionMethods, [
  { key: "printing_press_maintenance", shortages: { paper: 1.25 } },
]);

const definitions = {
  buildings: { workshop: { employmentSize: 0.1 } },
  methods: { workshop_method: { produced: "books", output: 1, inputs: { paper: 2 } } },
};
const market = {
  number: 5,
  goods: { paper: { price: 3 }, books: { price: 10 } },
  merchants: [
    { country: 1, capacity: 10.5, used: 7 },
    { country: 2, capacity: 4, used: 1 },
  ],
};
const loc = { number: 10, owner: 1, market: 5, marketAccess: 0.8, rank: "rural_settlement", popIds: [1, 2] };

// Two employed levels at 80% access: scale=1.6; input=9.6, base gross=16.
// A displayed +81.07% modifier therefore produces profit 16*1.8107-9.6.
const targetEfficiency = 0.8107;
const building = {
  number: 1,
  type: "workshop",
  level: 2,
  employed: 0.2,
  location: 10,
  owner: 1,
  lastMonthsProfit: 16 * (1 + targetEfficiency) - 9.6,
  productionMethods: [{ key: "workshop_method", shortages: {} }],
};
assert.ok(
  Math.abs(AdditionalMetrics.productionEfficiencyForBuilding(building, loc, market, definitions) - targetEfficiency) < 1e-12
);

// Current shortage quantities and last-month normalized profit are not on a
// compatible sampling basis, so a shortage-affected building is excluded.
const shortageBuilding = {
  ...building,
  number: 2,
  level: 1,
  employed: 0.1,
  lastMonthsProfit: 5 * 1.25 - 3,
  productionMethods: [{ key: "workshop_method", shortages: { paper: 0.6 } }],
};
assert.strictEqual(AdditionalMetrics.productionEfficiencyForBuilding(shortageBuilding, loc, market, definitions), null);

// last_months_profit is normalized to a fully staffed active level. A real
// building can therefore be severely under-employed without changing the
// basis used to reverse the modifier (Lavenham's Charcoal Kiln is 116/1,000).
const underemployedEfficiency = 0.1835;
const underemployedBuilding = {
  ...building,
  number: 3,
  level: 1,
  employed: 0.011668,
  lastMonthsProfit: 8 * (1 + underemployedEfficiency) - 4.8,
};
assert.ok(
  Math.abs(AdditionalMetrics.productionEfficiencyForBuilding(underemployedBuilding, loc, market, definitions) - underemployedEfficiency) < 1e-12
);

const urbanLoc = { ...loc, number: 11, owner: 2, rank: "town", popIds: [] };
const urbanEfficiency = 0.4;
const urbanBuilding = {
  ...building,
  number: 4,
  level: 1,
  employed: 0.1,
  location: 11,
  owner: 2,
  lastMonthsProfit: 8 * (1 + urbanEfficiency) - 4.8,
};

const result = {
  countries: [{ number: 1 }, { number: 2 }],
  locations: [loc, urbanLoc],
  popRecords: [
    { number: 1, size: 2, literacy: 25 },
    { number: 2, size: 6, literacy: 75 },
  ],
  markets: [
    market,
    { number: 6, goods: market.goods, merchants: [{ country: 1, capacity: 2.5, used: 2 }] },
  ],
  buildings: [building, shortageBuilding, underemployedBuilding, urbanBuilding],
};
AdditionalMetrics.applySaveBackedMetrics(result);
assert.strictEqual(result.locations[0].literacy, 62.5);
assert.strictEqual(result.countries[0].literacy, 62.5);
assert.strictEqual(result.countries[0].tradeCapacity, 13);
assert.strictEqual(result.countries[0].usedTradeCapacity, 9);

const coverage = AdditionalMetrics.applyProductionEfficiency(result, definitions);
assert.deepStrictEqual(coverage, {
  resolvedBuildings: 3,
  locations: 2,
  countries: 2,
  ruralLocations: 1,
  urbanLocations: 1,
  ruralCountries: 1,
  urbanCountries: 1,
});
assert.ok(Math.abs(result.locations[0].averageBuildingProductionEfficiency - (targetEfficiency * 2 + underemployedEfficiency) / 3) < 1e-12);
assert.strictEqual(result.countries[0].averageBuildingProductionEfficiency, result.locations[0].averageBuildingProductionEfficiency);
assert.strictEqual(result.locations[0].averageRuralBuildingProductionEfficiency, result.locations[0].averageBuildingProductionEfficiency);
assert.strictEqual(result.countries[0].averageRuralBuildingProductionEfficiency, result.countries[0].averageBuildingProductionEfficiency);
assert.strictEqual(result.locations[0].averageUrbanBuildingProductionEfficiency, undefined);
assert.ok(Math.abs(result.locations[1].averageUrbanBuildingProductionEfficiency - urbanEfficiency) < 1e-12);
assert.ok(Math.abs(result.countries[1].averageUrbanBuildingProductionEfficiency - urbanEfficiency) < 1e-12);
assert.strictEqual(result.locations[1].averageRuralBuildingProductionEfficiency, undefined);
assert.strictEqual(AdditionalMetrics.productionEfficiencySettlementGroup({ rank: "town" }), "Urban");
assert.strictEqual(AdditionalMetrics.productionEfficiencySettlementGroup({ rank: "city" }), "Urban");
assert.strictEqual(AdditionalMetrics.productionEfficiencySettlementGroup({ rank: "megalopolis" }), "Urban");
assert.strictEqual(AdditionalMetrics.productionEfficiencySettlementGroup({ rank: "rural_settlement" }), "Rural");
assert.strictEqual(AdditionalMetrics.productionEfficiencySettlementGroup({}), null);

console.log("additional save metrics: OK");
