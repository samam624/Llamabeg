"use strict";

const assert = require("assert");
const Finder = require("../js/modifier-finder.js");

const scan = {
  modifierKey: "selling_efficiency",
  generatedFrom: "fixture",
  eligibilityData: {
    ageYears: { age_1: 1, age_2: 1342, age_5: 1637 },
    cultures: { tst_culture: { language: "test_language", groups: ["test_group"] } },
    unlockIndex: { law: {}, policy: {}, governmentReform: {}, estatePrivilege: {} },
    booleanModifierSources: {
      has_ashta_pradham_council_policies: [
        { folder: "government_reforms", entity: "mhr_ashta_pradhan", group: null, choice: "mhr_ashta_pradhan" },
      ],
    },
  },
  direct: [
    { folder: "advances", entity: "trade_advance", path: ["trade_advance"], resolvedValue: 0.025, eligibility: { age: "age_1", requires: [], potential: [], allow: [] } },
    { folder: "government_reforms", entity: "market_reform", path: ["market_reform", "country_modifier"], resolvedValue: 0.05, eligibility: { age: "age_5", requires: [], potential: [], allow: [] } },
    { folder: "laws", entity: "maritime_law", path: ["maritime_law", "free_ports", "country_modifier"], resolvedValue: 0.025, eligibility: { age: null, requires: [], potential: [{ has_or_had_tag: "TST" }], allow: [], lawCategory: "socioeconomic" } },
    { folder: "laws", entity: "maritime_law", path: ["maritime_law", "protected_routes", "country_modifier"], resolvedValue: 0.01, eligibility: { age: null, requires: [], potential: [], allow: [] } },
    { folder: "advances", entity: "mercantile_spirit", path: ["mercantile_spirit"], resolvedValue: 0.02, eligibility: { age: "age_1", requires: ["trade_advance"], potential: [{ OR: { culture: ["culture:neapolitan", { merged_culture_group_contains_culture: "culture:neapolitan" }] } }], allow: [] } },
    { folder: "laws", entity: "ashta_pradhan_council_law", path: ["ashta_pradhan_council_law", "apc_mazumdar_focus_policy", "country_modifier"], resolvedValue: 0.02, eligibility: { age: null, requires: [], potential: [{ has_ashta_pradham_council_policies: true }], allow: [] } },
    { folder: "laws", entity: "trade_relations", path: ["trade_relations", "chinese_tribute_policy", "country_modifier"], resolvedValue: 0.01, eligibility: { age: null, requires: [], potential: [{ international_organization_type: "international_organization_type:jurchen_confederation" }], allow: [], organizationType: "international_organization_type:jurchen_confederation" } },
    { folder: "religions", entity: "merchant_faith", path: ["merchant_faith"], resolvedValue: 0.1 },
  ],
  bundles: [
    {
      bundleId: "trade_boom",
      resolvedValue: 0.05,
      grantors: [
        { category: "events", file: "trade_events.txt", entity: "trade.1", duration: { unit: "years", value: 10 } },
        { category: "missions", file: "missions/trade_missions.txt", entity: "trade_mission", duration: null },
      ],
    },
    {
      bundleId: "event_only_bonus",
      resolvedValue: 0.025,
      grantors: [{ category: "events", file: "country_events.txt", entity: "country.2", duration: { unit: "years", value: 5 } }],
    },
  ],
};

const country = {
  number: 1,
  tag: "TST",
  currentDate: "1455.2.1",
  players: ["Player"],
  modifierState: {
    currentTag: "TST",
    originalTag: "TST",
    researchedAdvances: ["trade_advance"],
    laws: { maritime_law: "protected_routes" },
    lawHistory: { maritime_law: { choice: "protected_routes", date: "1450.1.1", days: 730 } },
    estatePrivileges: [],
    governmentReforms: [],
    estateTypes: ["burghers_estate"],
    variableKeys: [],
    primaryCulture: "tst_culture",
    internationalOrganizations: [{ type: "union", leader: false, laws: {}, lawHistory: {} }],
  },
};

const report = Finder.buildModifierReport(scan, country);
assert.deepStrictEqual(report.activeSources.map((source) => source.choice).sort(), ["protected_routes", "trade_advance"]);
assert.deepStrictEqual(report.recommendations.map((source) => source.choice), ["free_ports"]);
assert.strictEqual(report.recommendations[0].currentChoice, "protected_routes");
assert.strictEqual(report.recommendations[0].category, "laws");
assert.strictEqual(report.recommendations[0].playerControlled, true);
assert.strictEqual(report.recommendations[0].eligibility.lawCategory, "socioeconomic");
assert.strictEqual(report.blockedSources[0].choice, "market_reform");
assert.match(report.blockedSources[0].eligibilityReasons[0], /1637/);
for (const id of ["mercantile_spirit", "apc_mazumdar_focus_policy", "chinese_tribute_policy"]) {
  const blocked = report.blockedSources.find((source) => source.choice === id);
  assert.ok(blocked, `${id} should be definitively blocked`);
}
assert.deepStrictEqual(report.unknownSources, []);
assert.strictEqual(report.otherSources[0].entity, "merchant_faith");
assert.strictEqual(report.knownActiveContribution, 0.035);
assert.strictEqual(report.optimizationIncludesTemporaryEvents, false);
assert.deepStrictEqual(report.eventSources.map((source) => source.bundleId), ["trade_boom", "event_only_bonus"]);
assert.ok(report.eventSources.every((source) => source.category === "events" && source.temporary && source.excludedFromOptimization));
assert.strictEqual(report.otherIndirectSources.length, 1);
assert.strictEqual(report.otherIndirectSources[0].category, "missions");
assert.ok(!report.recommendations.some((source) => source.bundleId === "trade_boom"));

const monthlyReport = Finder.buildModifierReport(Object.assign({}, scan, { modifierKey: "monthly_towards_aristocracy", bundles: [] }), country);
assert.strictEqual(monthlyReport.valueFormat, "monthly_points");
assert.ok(monthlyReport.activeSources.every((source) => source.valueFormat === "monthly_points"));
assert.strictEqual(monthlyReport.knownActiveContribution, 0.035);

assert.deepStrictEqual(
  Finder.buildSocietalEquilibrium({ knownActiveContribution: 0.55 }, { knownActiveContribution: 0.25 }, "decentralization", "centralization"),
  { selectedRate: 0.55, opposingRate: 0.25, netRate: 0.30000000000000004, directionId: "decentralization", position: 30.000000000000004 }
);
assert.strictEqual(Finder.buildSocietalEquilibrium({ knownActiveContribution: 0.1 }, { knownActiveContribution: 0.3 }, "decentralization", "centralization").directionId, "centralization");

const dynamicCountry = Object.assign({}, country, {
  modifierState: Object.assign({}, country.modifierState, {
    societalDynamics: {
      averageOwnedLocationDevelopment: 10,
      averageOwnedLocationControl: 0.3,
      subjectTypeCounts: { vassal: 1 },
    },
  }),
});
const decentralizationReport = Finder.buildModifierReport(
  Object.assign({}, scan, {
    modifierKey: "monthly_towards_decentralization",
    bundles: [],
    direct: [{ folder: "subject_types", entity: "vassal", path: ["vassal", "overlord_modifier"], resolvedValue: 0.025 }],
  }),
  dynamicCountry
);
const centralizationReport = Finder.buildModifierReport(Object.assign({}, scan, { modifierKey: "monthly_towards_centralization", bundles: [], direct: [] }), dynamicCountry);
assert.strictEqual(decentralizationReport.knownActiveContribution, 0.025);
assert.strictEqual(decentralizationReport.activeSources[0].category, "subject_types");
assert.strictEqual(centralizationReport.knownActiveContribution, 0.05);
assert.deepStrictEqual(centralizationReport.activeSources.map((source) => source.entity).sort(), ["average_control_in_country", "average_development_in_country"]);
assert.strictEqual(Finder.buildSocietalEquilibrium(decentralizationReport, centralizationReport, "decentralization", "centralization").position, 2.5);

const hunDynamics = {
  averageOwnedLocationDevelopment: 16.84127915343916,
  averageOwnedLocationControl: 0.25944544973544975,
  averageLiteracy: 10.353163178005472,
  stateReligionClergyShare: 0.006230661539249202,
  primaryReligionShare: 0.8541168576019296,
  primaryCultureNoblesShare: 0.0035586348854052825,
  populationShares: { peasants: 0.8923875131383925, burghers: 0.0037703677914240692, soldiers: 0.005278388262066895 },
  armyTradition: 0.14926,
  atWar: false,
  maintenances: { FortMaintenance: 1 },
  characterTraits: { ruler: ["bold_fighter", "charismatic_negotiator"] },
  countryArtQualityShare: 0.026695604991861095,
  historicalTaxBase: 83.57947,
  historicalEconomicBase: 163.97599,
  employmentSystem: "first_come_first_serve",
  subjectTypeCounts: {},
};
const hun = Object.assign({}, country, { modifierState: Object.assign({}, country.modifierState, { societalDynamics: hunDynamics }) });
function dynamicTotal(modifierKey, direct) {
  return Finder.buildModifierReport(Object.assign({}, scan, { modifierKey, direct: direct || [], bundles: [] }), hun);
}
assert.ok(Math.abs(dynamicTotal("monthly_towards_innovative").knownActiveContribution - 0.06374437316172766) < 1e-12);
assert.ok(Math.abs(dynamicTotal("monthly_towards_quantity").knownActiveContribution - 0.0026391941310334476) < 1e-12);
assert.ok(Math.abs(dynamicTotal("monthly_towards_land").knownActiveContribution - 0.00014926) < 1e-12);
assert.strictEqual(dynamicTotal("monthly_towards_defensive").knownActiveContribution, 0.1);
assert.strictEqual(dynamicTotal("monthly_towards_traditional_economy").activeSources.some((source) => source.entity === "first_come_first_serve_employment_system"), true);

const conditionalLawScan = Object.assign({}, scan, {
  modifierKey: "monthly_towards_traditionalist",
  bundles: [],
  direct: [
    { folder: "laws", entity: "church_law", path: ["church_law", "current_policy", "country_modifier"], resolvedValue: 0.1, eligibility: { organizationType: "international_organization_type:catholic_church", potential: [], allow: [] }, impactPotential: { is_leader_of_international_organization: "international_organization:catholic_church" } },
    { folder: "laws", entity: "church_law", path: ["church_law", "current_policy", "country_modifier"], resolvedValue: 0.05, eligibility: { organizationType: "international_organization_type:catholic_church", potential: [], allow: [] }, impactPotential: { NOT: { is_leader_of_international_organization: "international_organization:catholic_church" } } },
  ],
});
const conditionalCountry = Object.assign({}, hun, { modifierState: Object.assign({}, hun.modifierState, { internationalOrganizations: [{ type: "catholic_church", leader: false, laws: { church_law: "current_policy" }, lawHistory: {} }] }) });
const conditionalReport = Finder.buildModifierReport(conditionalLawScan, conditionalCountry);
assert.strictEqual(conditionalReport.knownActiveContribution, 0.05, "member must not also receive the leader-only law modifier");

const estatePrivilegeReport = Finder.buildModifierReport(Object.assign({}, scan, {
  modifierKey: "monthly_towards_serfdom",
  bundles: [],
  direct: [
    { folder: "estate_privileges", entity: "expensive_rights", displayName: "Expensive Rights", estate: "burghers_estate", estateLabel: "Burghers", estatePowerCost: 0.5, path: ["expensive_rights", "country_modifier"], resolvedValue: 0.2, eligibility: { estate: "burghers_estate", potential: [], allow: [] } },
    { folder: "estate_privileges", entity: "cheap_rights", displayName: "Cheap Rights", estate: "burghers_estate", estateLabel: "Burghers", estatePowerCost: 0.1, path: ["cheap_rights", "country_modifier"], resolvedValue: 0.1, eligibility: { estate: "burghers_estate", potential: [], allow: [] } },
    { folder: "estate_privileges", entity: "unknown_cost_rights", displayName: "Unknown Cost Rights", estate: "burghers_estate", estateLabel: "Burghers", estatePowerCost: null, path: ["unknown_cost_rights", "country_modifier"], resolvedValue: 0.3, eligibility: { estate: "burghers_estate", potential: [], allow: [] } },
    { folder: "estate_privileges", entity: "cossack_rights", displayName: "Cossack Rights", estate: "cossacks_estate", estateLabel: "Cossacks", estatePowerCost: 0.05, path: ["cossack_rights", "country_modifier"], resolvedValue: 0.4, eligibility: { estate: "cossacks_estate", potential: [], allow: [] } },
  ],
}), country);
assert.deepStrictEqual(estatePrivilegeReport.recommendations.map((source) => source.displayName), ["Cheap Rights", "Expensive Rights", "Unknown Cost Rights"]);
assert.deepStrictEqual(estatePrivilegeReport.recommendations.map((source) => source.estatePowerCost), [0.1, 0.5, null]);
assert.deepStrictEqual(estatePrivilegeReport.country.activeEstates, [{ id: "burghers_estate", label: "Burghers" }]);
assert.deepStrictEqual(estatePrivilegeReport.blockedSources.map((source) => source.displayName), ["Cossack Rights"]);
assert.match(estatePrivilegeReport.blockedSources[0].eligibilityReasons[0], /Requires active estate: cossacks estate/i);
const unknownEstateCountry = Object.assign({}, country, { modifierState: Object.assign({}, country.modifierState, { estateTypes: null }) });
const unknownEstateReport = Finder.buildModifierReport(Object.assign({}, scan, {
  modifierKey: "monthly_towards_serfdom",
  bundles: [],
  direct: [{ folder: "estate_privileges", entity: "cossack_rights", estate: "cossacks_estate", path: ["cossack_rights", "country_modifier"], resolvedValue: 0.4, eligibility: { estate: "cossacks_estate", potential: [], allow: [] } }],
}), unknownEstateCountry);
assert.strictEqual(unknownEstateReport.recommendations.length, 0);
assert.strictEqual(unknownEstateReport.unknownSources.length, 1);

// international_organization_type must be a membership-only gate - an
// ordinary (non-leader) member of a matching-type IO should be eligible, not
// blocked pending leadership. Verified against real HRE law groups in
// game/in_game/common/laws/20_hre.txt, whose potential is bare
// `international_organization_type = ...` with no leadership clause.
const memberIoReport = Finder.buildModifierReport(Object.assign({}, scan, {
  modifierKey: "monthly_towards_traditionalist",
  bundles: [],
  direct: [{ folder: "laws", entity: "trade_relations", path: ["trade_relations", "member_policy", "country_modifier"], resolvedValue: 0.01, eligibility: { potential: [{ international_organization_type: "international_organization_type:union" }], allow: [] } }],
}), country);
assert.deepStrictEqual(memberIoReport.recommendations.map((source) => source.choice), ["member_policy"], "an ordinary IO member should be eligible, not blocked pending leadership");

// "tag" (COUNTRYTAG_TRIGGER, current-tag-only) must not accept a country's
// former tag the way "has_or_had_tag"/"original_tag" do - verified against
// the game's own triggers_l_english.yml wording ("Is $NAME$" vs "Is or was
// $NAME$" vs "Was originally $NAME$").
const switchedCountry = Object.assign({}, country, {
  modifierState: Object.assign({}, country.modifierState, { currentTag: "SPA", originalTag: "CAS" }),
});
const tagScan = (key, target) => Object.assign({}, scan, {
  modifierKey: "monthly_towards_traditionalist",
  bundles: [],
  direct: [{ folder: "laws", entity: "castile_law", path: ["castile_law", "castile_policy", "country_modifier"], resolvedValue: 0.01, eligibility: { potential: [{ [key]: target }], allow: [] } }],
});
assert.strictEqual(Finder.buildModifierReport(tagScan("tag", "CAS"), switchedCountry).blockedSources.length, 1, "tag=CAS must not match a country that switched away from CAS");
assert.strictEqual(Finder.buildModifierReport(tagScan("original_tag", "CAS"), switchedCountry).recommendations.length, 1, "original_tag=CAS must match the country's original tag");
assert.strictEqual(Finder.buildModifierReport(tagScan("has_or_had_tag", "CAS"), switchedCountry).recommendations.length, 1, "has_or_had_tag=CAS must match a former tag");
assert.strictEqual(Finder.buildModifierReport(tagScan("tag", "SPA"), switchedCountry).recommendations.length, 1, "tag=SPA must match a country whose current tag is SPA");

console.log("modifier-finder tests passed");
