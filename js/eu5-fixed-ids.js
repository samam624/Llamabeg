// Fixed 2-byte key IDs used by EU5's binary Clausewitz encoding, mapped to
// their plaintext field names. Discovered empirically by diffing a decoded
// binary save against the ground-truth melted text of the same save (see
// test/decode-trace.js, test/decode-countries.js, test/decode-played-country.js
// in this repo's history for the derivation).
//
// These IDs are NOT guaranteed stable across major game patches (Paradox may
// append new ones, and in principle could renumber - we have no way to
// verify long-term stability from one save). Callers must treat an unknown
// ID as a soft failure (fall back to a "#hex" placeholder), never a hard
// error - see js/clausewitz-binary.js.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.EU5FixedIds = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // hex string (no "0x" prefix, lowercase) -> field name
  return {
    // envelope / metadata
    "9de": "metadata",
    "522": "multiplayer",
    "6b5": "date",
    "96e": "playthrough_id",
    "96f": "playthrough_name",
    "971": "save_label",
    ee: "version",
    "37c5": "incompatible",
    "384": "flag",
    "3bb5": "player_country_name",
    "3477": "code_version_info",
    "347c": "game_code_info",
    "3478": "code_hash_long",
    "3479": "code_hash_short",
    "347a": "code_timestamp",
    "347b": "code_branch",
    "35c3": "code_commit",
    "347d": "engine_code_info",
    "2ce7": "enabled_dlcs",
    "3237": "compatibility",
    "3238": "locations_hash",
    "2dc0": "locations",

    // top level
    "2ccc": "countries",
    "2ce3": "played_country",
    "2dcd": "culture_manager",
    "2de1": "religion_manager",
    "2e94": "market_manager",
    "312f": "situation_manager",
    "31df": "war_manager",
    "2e6b": "building_manager",
    "2ebc": "loan_manager",

    // war_manager.database entries. Derived by position-matching a
    // generically-decoded war object against the melted text of the exact
    // same war id (by number, cross-format-stable) across three real wars
    // covering the concluded/active/revolt/subject-call variants - see
    // test/ derivation convention in README's binary-parser section.
    // "country"/"date"/"score"/"status"/"locations" fields inside a war
    // entry reuse the SAME fixed IDs already listed elsewhere in this file
    // (2cd7/6b5/2b36/d0/2dc0) - confirmed, not re-listed here. Enum-like
    // values (Attacker/Defender/Instigator/Target/Active/Left/WarEnded/...)
    // and the Combat/Siege/JoiningWar score sub-keys resolve dynamically
    // via string_lookup, no fixed ID needed for those.
    "2ca2": "names",
    "465": "all",
    "31aa": "history",
    // Seen in current binary autosaves for participant history; older
    // derivation saves used 31aa for the same melted field name.
    "3db9": "history",
    "3773": "request",
    "2b64": "reason",
    "32ac": "join_type",
    "33": "side",
    "3038": "revolter",
    "307b": "called_ally",
    "399a": "joined",
    "2efe": "losses",
    "73": "left",
    "304e": "original_attacker",
    "3c10": "original_attacker_target",
    "3746": "original_defenders",
    "3060": "revolt",
    "2d38": "previous",
    cf9: "end_date",
    cf8: "start_date",
    "3050": "war_goal_held",
    "3053": "attacker_score",
    "3054": "defender_score",
    // War-wide casualty totals, unlike attacker_score/defender_score above -
    // confirmed these survive war conclusion (present with real values on a
    // real `previous=yes` war entry), which is exactly why they're useful:
    // see js/clausewitz.js's extractWarFields sumLosses() and the win/loss
    // heuristic in js/llama-score.js.
    "3534": "attacker_losses",
    "3535": "defender_losses",
    "3059": "stalled_years",
    // countries container
    "1cf": "tags",
    "5ab": "database",

    // loan_manager.database entries (loan_manager.database itself reuses the
    // same "5ab" database ID as war_manager.database/countries.tags above -
    // confirmed, not war-specific). Derived by generically decoding
    // loan_manager (test/debug-loan-manager.js) and position-matching entries
    // 12-16 against the melted text of the same save
    // (autosave_10729752-2bb9-4170-86a9-2bddb274563a) - exact value match
    // (amount=16.12447, interest=0.1, month=32, borrower=4) confirmed all
    // four fields at once. A loan entry can also carry a "lender" field
    // (seen on a real entry, player-to-player loans presumably) - not
    // resolved/needed since only amount+borrower matter for the llama
    // war-scoring debt-netting use case; treat as an unknown "#hex" fallback
    // if it ever needs reading.
    "1a1": "amount",
    "2ec0": "interest",
    "7b": "month",
    "2ebf": "borrower",

    // situation_manager.<situation_name> entries (situation names themselves,
    // e.g. black_death, are string_lookup refs, not fixed IDs). start/end
    // are raw hour counts, same encoding as metadata.date.
    d0: "status",
    "69": "start",
    "1a0": "end",
    // black_death.variables.data[].data is {type=disease_outbreak,
    // identity=N} - a pointer to this campaign's specific instance in
    // disease_outbreak_manager.data[].countries[].deaths[].disease_outbreak
    // (same 3646 token both as a key and as this enum-tag value - Clausewitz
    // uses one token per string regardless of position). Derived by
    // byte-tracing autosave_3baa76aa-...eu5's gamestate against its melted
    // twin (position-matched: county=2153/deaths=179.50281 for outbreak
    // identity 2617 in both).
    "555": "variables",
    f0: "data",
    db: "identity",
    "3646": "disease_outbreak",
    "27e2": "county",
    "3759": "deaths",

    // provinces.database entries - a COARSER grouping than locations.locations
    // (matches definitions.txt's "_province" level: several locations per
    // province). Its own owner=/capital= fields can be set even when an
    // individual location within it has no owner of its own - this is the
    // real root cause of a location showing "unowned" on the map/in the
    // location detail panel despite being controlled in-game and in other
    // tools (confirmed: verona/venice/vicenza in a real save all had blank
    // locations.locations owner fields while their containing province -
    // verona_province, venice_province, vicenza_province - had a real
    // owner). Derived the same way as the disease_outbreak_manager IDs
    // above, byte-tracing autosave_a881d67a-...eu5 (entry 0:
    // province_definition="uppland_province", capital=1, owner=3, matching
    // the melted text exactly).
    "6b7": "provinces",
    "2dc2": "province_definition",

    // estate_manager.database entries. Buildings and roads live here as
    // estate assets pointing back to a location, not directly under the
    // locations.locations entry.
    "35ae": "estate_type",
    "3841": "balance",
    "3cc9": "wealth_impact",
    "3cd1": "last_month",
    "2ea5": "satisfaction",
    "3d43": "rgo",
    "2a2a": "existence",
    "27f6": "location",
    "275a": "building",
    "3894": "start_location",
    "3895": "end_location",
    "3803": "road_type",
    "2dce": "culture_definition",
    "3281": "employed",
    "39a3": "employment_requirement",
    "39a4": "employment_requirement_status",
    "3735": "last_months_profit",
    "3a46": "upkeep",

    // per-country fields
    "2cc6": "country_name",
    "7dd": "definition",
    e1: "type",
    "2ccf": "historical",
    "3c1f": "original_tag",
    "753": "level",
    "2cdf": "country_type",
    "2b36": "score",
    "36a5": "score_place",
    "36a8": "score_rating",
    "36a9": "score_rank",
    "2d47": "currency_data",
    "2d0d": "manpower",
    "2d0e": "sailors",
    "2875": "gold",
    "2d0f": "stability",
    "2ed2": "inflation",
    "2b26": "prestige",
    "2f2c": "army_tradition",
    "2f2d": "navy_tradition",
    "2fb0": "government_power",
    "3188": "karma",
    "3187": "religious_influence",
    "33bb": "purity",
    "36e0": "righteousness",
    "3cd6": "complacency",
    "37af": "balance_history_2",
    "2e8c": "monthly_manpower",
    "2e8d": "monthly_sailors",
    "3b40": "last_month_manpower_income",
    "3b3f": "last_month_sailors_income",
    "3525": "last_month_gold_income",
    "2ea0": "max_manpower",
    "2ea1": "max_sailors",
    "37e4": "total_produced",
    "37c0": "last_month_produced",
    "2df6": "government",
    "2e24": "heir_selection",
    "2df3": "ruler",
    "2df4": "consort",
    "2df5": "heir",
    "3148": "court_language",
    "3def": "ai_personality",
    "27fd": "capital",
    "3d35": "game_start_capital",
    "3d36": "default_capital",
    "2e92": "economy",
    "35c4": "primary_culture",
    "35c5": "primary_religion",
    "56": "color",
    "38ad": "great_power_rank",
    "3e8c": "regional_power",
    "3e8d": "great_power_points",
    "38f6": "last_months_tax_income",
    "3be1": "last_months_manpower_expense",
    "3b45": "last_months_sailor_expense",
    "3ccd": "last_months_subject_tax",
    "3730": "last_months_army_maintenance",
    "3731": "last_months_navy_maintenance",
    "3b50": "last_months_fort_maintenance",
    "3b4e": "last_months_building_maintenance",
    "322d": "owned_locations",
    "322f": "controlled_locations",
    "3230": "core_locations",
    "2f2f": "expected_army_size",
    "2f31": "expected_navy_size",
    "30a9": "naval_range",
    "38b0": "colonial_range",
    "36b2": "last_months_population",
    "31ab": "historical_population",
    "31ac": "historical_tax_base",
    "3ee5": "historical_economical_base",

    // location.population sub-object
    "35d1": "pop_stats",
    "31d5": "biggest",
    "31dc": "pops",
    "2cf5": "population_ratio",
    "3282": "unemployed",
    "35e7": "employed_in_rgo",
    "2e51": "produced",
    "2c3d": "changes",

    // economy subobject fields
    "3250": "tax_rates",
    "3251": "maintenances",
    "3ecd": "creditworthiness",
    "2ed3": "coin_minting",
    "3707": "loan_capacity",
    "2d76": "expense",
    "2d75": "income",
    "31a5": "monthly_gold",
    "31b5": "recent_balance",
    "2c62": "counters",

    // diplomacy_manager / subject-overlord ("dependency") records
    "2fc3": "diplomacy_manager",
    "2ff3": "dependency",
    "277f": "first",
    "28e1": "second",
    "3826": "named_targets",
    "6b": "target",
    "41": "object",

    // played_country
    "1b": "name",
    b: "id",
    "351c": "same_name",
    "2cd7": "country",
    "392c": "player_proficiency",
    "830": "pins",
    "34e6": "control_groups",
    "2f": "size",
    "3544": "preferred_map_mode",
    "3533": "played_country_counters",

    // locations.locations entries (per-location fields, for mapmodes) -
    // derived the same way, by position-matching a decoded binary location
    // object against locations={locations={1={...}}} in melted text.
    "2812": "owner",
    "2cd3": "controller",
    "2cd4": "previous_owner",
    "3139": "market",
    "3554": "second_best_market",
    "31cd": "market_access",
    "361e": "market_attraction",
    "360f": "second_best_market_access",
    "324f": "cores",
    "384f": "scripted_cores",
    "3850": "scripted_core_country",
    "3851": "scripted_core_grant_date",
    "27fc": "religion",
    "27f4": "culture",
    bb: "language",
    "339e": "dialect",
    "2cd1": "last_owner_change",
    "2cd2": "last_controller_change",
    df: "rank",
    "3ea3": "original_rank",
    "2e50": "raw_material",
    "32": "center",
    "3405": "max_raw_material_workers",
    "2e58": "prosperity",
    "2e5a": "development",
    "2e60": "control",
    "3d37": "road_to_capital",
    "31cc": "proximity",
    "3503": "local_proximity_propagation",
    "3504": "value_flow",
    "27d2": "province",
    "2de7": "winter",
    "29bc": "tax",
    "36fb": "possible_tax",
    "37c6": "estate_tax",
    "3d73": "estate_possible_tax",
    "324c": "institutions",
    "2f21": "ub",
    "2d9f": "population",
  };
});
