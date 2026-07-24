const assert = require("assert");
const path = require("path");
const Clausewitz = require(path.join(__dirname, "..", "js", "clausewitz.js"));

const baseCountry = {
  tag: "BYZ",
  currency_data: {},
  government: {},
  economy: {},
};

const resolved = Clausewitz.extractCountryFields(
  203,
  { ...baseCountry, last_months_trade_income: 320.49149 },
  false
);
assert.strictEqual(resolved.lastMonthsTradeIncome, 320.49149);

// Keep the extractor robust when invoked before/without the fixed-ID
// resolver. Production binary parsing resolves 0x36f8 to the friendly key.
const unresolved = Clausewitz.extractCountryFields(
  203,
  { ...baseCountry, "#36f8": 320.49149 },
  false
);
assert.strictEqual(unresolved.lastMonthsTradeIncome, 320.49149);

const missing = Clausewitz.extractCountryFields(203, baseCountry, false);
assert.strictEqual(missing.lastMonthsTradeIncome, undefined);

const burgherEstate = Clausewitz.extractEstateAssetFields(1001, {
  country: 203,
  estate_type: "burghers_estate",
  last_month: {
    trade_income: 375.98938,
    paid_taxes: 130.2568,
  },
});
assert.deepStrictEqual(
  {
    country: burgherEstate.country,
    estateType: burgherEstate.estateType,
    tradeIncome: burgherEstate.tradeIncome,
    paidTaxes: burgherEstate.paidTaxes,
  },
  {
    country: 203,
    estateType: "burghers_estate",
    tradeIncome: 375.98938,
    paidTaxes: 130.2568,
  }
);

const taxResolved = Clausewitz.extractCountryFields(
  203,
  { ...baseCountry, last_months_tax_income: 371.19028 },
  false
);
assert.strictEqual(taxResolved.lastMonthsTaxIncome, 371.19028);

console.log("state-income extractors: OK");
