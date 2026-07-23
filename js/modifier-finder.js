(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ModifierFinder = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const TRACKED_FOLDERS = new Set(["advances", "estate_privileges", "government_reforms", "laws"]);
  const SOURCE_CATEGORIES = {
    advances: { label: "Advances", playerControlled: true },
    laws: { label: "Laws", playerControlled: true },
    estate_privileges: { label: "Estate Privileges", playerControlled: true },
    government_reforms: { label: "Government Reforms", playerControlled: true },
    events: { label: "Events", playerControlled: false },
    missions: { label: "Mission Rewards", playerControlled: false },
    decisions: { label: "Decisions", playerControlled: false },
    actions: { label: "Scripted Actions", playerControlled: false },
    situations: { label: "Situations and Disasters", playerControlled: false },
    scripted: { label: "Scripted or Static Sources", playerControlled: false },
    subject_types: { label: "Subject Relationships", playerControlled: false },
    dynamic_country_state: { label: "Country State", playerControlled: false },
    character_traits: { label: "Ruler Traits", playerControlled: false },
    societal_values: { label: "Societal Values", playerControlled: false },
    gods: { label: "Omens", playerControlled: true },
    other: { label: "Other Direct Sources", playerControlled: false },
  };
  const UNLOCK_TRIGGER_KINDS = {
    has_unlocked_law_trigger: ["law", "unlocked_law_"],
    has_unlocked_policy_trigger: ["policy", "unlocked_policy_"],
    has_unlocked_government_reform_trigger: ["governmentReform", "unlocked_government_reform_"],
    has_unlocked_estate_privilege_trigger: ["estatePrivilege", "unlocked_estate_privilege_"],
  };

  function asSet(value) {
    return new Set(Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);
  }

  function withoutScope(value) {
    if (typeof value !== "string") return value;
    const index = value.indexOf(":");
    return index === -1 ? value : value.slice(index + 1);
  }

  function sourceIdentity(source) {
    const path = Array.isArray(source.path) ? source.path : [];
    if (source.folder === "laws") return { group: path[0] || source.entity, choice: path[1] || source.entity };
    // path = [god, "omens", omen_id, ...] - the omen is what a user actually
    // picks, so it's the "choice" here the same way a law's specific option
    // is, with the god as the group (matching compactEligibility()'s omenId
    // extraction in tools/scan-modifier-sources.js).
    if (source.folder === "gods" && path[1] === "omens") return { group: path[0] || source.entity, choice: path[2] || source.entity };
    return { group: null, choice: source.entity };
  }

  function sourceCategory(source) {
    const category = source && source.folder === "traits"
      ? "character_traits"
      : source && source.folder === "auto_modifiers"
        ? "dynamic_country_state"
        : source && SOURCE_CATEGORIES[source.folder]
          ? source.folder
          : "other";
    return {
      category,
      categoryLabel: SOURCE_CATEGORIES[category].label,
      playerControlled: SOURCE_CATEGORIES[category].playerControlled,
      temporary: false,
      excludedFromOptimization: !SOURCE_CATEGORIES[category].playerControlled,
    };
  }

  function indirectSource(bundle, category, grantors, valueFormat) {
    const definition = SOURCE_CATEGORIES[category] || SOURCE_CATEGORIES.scripted;
    return Object.assign({}, bundle, {
      category,
      valueFormat,
      categoryLabel: definition.label,
      playerControlled: false,
      temporary: category === "events",
      informationalOnly: true,
      excludedFromOptimization: true,
      grantors,
    });
  }

  function societalDynamicSources(modifierKey, modifierState) {
    const dynamics = modifierState && modifierState.societalDynamics;
    if (!dynamics || typeof dynamics !== "object") return [];
    const development = dynamics.averageOwnedLocationDevelopment;
    const control = dynamics.averageOwnedLocationControl;
    const sources = [];
    function add(entity, value, rawValue, detail) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return;
      sources.push({
        folder: "dynamic_country_state",
        entity,
        path: [entity],
        resolvedValue: value,
        rawValue,
        dynamicActive: true,
        formulaDetail: detail || null,
      });
    }
    const pop = dynamics.populationShares || {};
    if (modifierKey === "monthly_towards_centralization") {
      add("average_development_in_country", development / 500, development, "average development / 500");
      add("average_control_in_country", control / 10, control, "average control / 10");
    }
    if (modifierKey === "monthly_towards_innovative") {
      add("average_literacy", dynamics.averageLiteracy * 0.001, dynamics.averageLiteracy, "average literacy × 0.001");
      add("our_works_of_art", dynamics.countryArtQualityShare * 2, dynamics.countryArtQualityShare, "share of world artwork quality × 2");
    }
    if (modifierKey === "monthly_towards_spiritualist") {
      add("primary_religion_clergy_ratio", Math.min(1, dynamics.stateReligionClergyShare * 100) * 0.1, dynamics.stateReligionClergyShare, "state-religion clergy share × 100, capped at 1, × 0.1");
      // EU5 does not serialize the engine's final intolerance scalar. The
      // minority-faith share is the stable save-backed input and reproduces
      // the displayed early-game value to the tooltip's two decimals.
      add("religious_intolerance", Math.max(0, 1 - dynamics.primaryReligionShare) * 0.5, dynamics.primaryReligionShare, "minority-faith share × 0.5 (save-backed estimate)");
    }
    if (modifierKey === "monthly_towards_aristocracy") {
      add("nobles_of_primary_or_accepted_culture_ratio", Math.min(1, dynamics.primaryCultureNoblesShare * 100) * 0.1, dynamics.primaryCultureNoblesShare, "proper-culture nobles share × 100, capped at 1, × 0.1");
    }
    if (modifierKey === "monthly_towards_quantity") add("percentage_of_soldiers", (pop.soldiers || 0) * 0.5, pop.soldiers || 0, "soldier population share × 0.5");
    if (modifierKey === "monthly_towards_capital_economy") {
      add("percentage_of_burghers", (pop.burghers || 0) * 0.5, pop.burghers || 0, "burgher population share × 0.5");
      const economic = dynamics.historicalEconomicBase;
      const tax = dynamics.historicalTaxBase;
      const trade = dynamics.estateTradeIncome;
      if (typeof economic === "number" && economic > 0 && typeof trade === "number" && trade >= 0) {
        add("trade_income_vs_tax_base", Math.max(0, Math.min(1, trade / economic)) * 0.1, { economic, trade }, "recorded estate trade income / economic base × 0.1 (save-backed estimate)");
      } else if (typeof economic === "number" && economic > 0 && typeof tax === "number") {
        add("trade_income_vs_tax_base", Math.max(0, Math.min(1, 1 - tax / economic)) * 0.1, { economic, tax }, "non-tax share of economic base × 0.1 (fallback estimate)");
      }
    }
    if (modifierKey === "monthly_towards_traditional_economy") {
      add("percentage_of_peasants", (pop.peasants || 0) * 0.1, pop.peasants || 0, "peasant population share × 0.1");
      if (dynamics.employmentSystem === "first_come_first_serve") add("first_come_first_serve_employment_system", 0.1, true, "current employment system");
    }
    if (modifierKey === "monthly_towards_land") add("army_tradition", (dynamics.armyTradition || 0) * 0.001, dynamics.armyTradition || 0, "army tradition × 0.01 × 0.1");
    if (modifierKey === "monthly_towards_conciliatory" && dynamics.atWar === false) add("at_peace", 0.1, true, "country is at peace");
    if (modifierKey === "monthly_towards_belligerent" && dynamics.atWar === true) add("at_war", 0.1, true, "country is at war");
    if (modifierKey === "monthly_towards_defensive") {
      const maintenance = dynamics.maintenances && dynamics.maintenances.FortMaintenance;
      add("fort_maintenance", (maintenance || 0) * 0.1, maintenance, "fort maintenance setting × 0.1");
    }
    return sources;
  }

  const MODELED_AUTOMATIC_ENTITIES = new Set([
    "average_development", "average_control", "average_literacy", "country_art",
    "state_religion_clergy_ratio", "religious_intolerance", "proper_culture_nobles_ratio",
    "soldier_percentage_in_country", "burghers_percentage", "peasants_percentage",
    "army_tradition", "at_peace", "at_war", "fort_maintenance_mod", "trade_vs_tax",
  ]);

  function classifyDynamicSource(source, modifierState) {
    if (source.dynamicActive) return { tracked: false, active: true, status: "active", currentChoice: null };
    if (source.folder === "traits" && modifierState && modifierState.societalDynamics) {
      const traits = modifierState.societalDynamics.characterTraits || {};
      const active = new Set([].concat(traits.ruler || [], traits.regent || []));
      if (active.has(source.entity)) return { tracked: false, active: true, status: "active", currentChoice: null };
    }
    // A societal-value axis grants its left_modifier/right_modifier bonuses
    // at full strength only at position ±100; the in-game "Current Impact"
    // popup interpolates linearly by the country's actual current position
    // (see docs/SOCIETAL_VALUES_ROADMAP.md #1) - reproduced here the same
    // way so a raw modifier key's active total matches what EU5 itself shows
    // instead of silently omitting societal-value-driven sources entirely.
    // `sourceCount` is reused as a fractional scale rather than an integer
    // count (buildModifierReport already multiplies resolvedValue by it).
    if (source.folder === "societal_values" && modifierState && modifierState.societalValues) {
      const position = modifierState.societalValues[source.entity];
      if (typeof position === "number") {
        const side = Array.isArray(source.path) ? source.path[1] : null;
        const strength = side === "right_modifier" ? Math.max(0, position) / 100 : side === "left_modifier" ? Math.max(0, -position) / 100 : 0;
        if (strength > 0) return { tracked: false, active: true, status: "active", currentChoice: null, sourceCount: strength };
      }
    }
    // Omens: EU5 lets a country favor one god per ability (ADM/DIP/MIL) and
    // pick one of that god's omens, but WHICH omen is currently selected is
    // not yet locatable in the save (checked the government block, country
    // fields, and the top-level religion_manager section - none of them hold
    // it; confirmed against a real save that the currently-active omen's own
    // definition wasn't even the only one present). So every omen this
    // country's religion could grant is surfaced as an unverified candidate
    // rather than a proven "eligible, replaces your current pick" law-style
    // recommendation - `currentChoice: null` deliberately, since we can't
    // name what it would replace. See modifierSourcePath()'s "Omens" note in
    // the desktop renderer for the same caveat surfaced to the user.
    if (source.folder === "gods") return { tracked: true, active: false, status: "candidate", currentChoice: null };
    if (source.folder !== "subject_types" || !modifierState || !modifierState.societalDynamics) return null;
    if (!Array.isArray(source.path) || !source.path.includes("overlord_modifier")) return null;
    const counts = modifierState.societalDynamics.subjectTypeCounts || {};
    const sourceCount = typeof counts[source.entity] === "number" ? counts[source.entity] : 0;
    if (sourceCount <= 0) return null;
    return { tracked: false, active: true, status: "active", currentChoice: null, sourceCount };
  }

  function organizationTypeForSource(source) {
    return withoutScope(source && source.eligibility && source.eligibility.organizationType);
  }

  function matchingOrganization(source, modifierState) {
    const type = organizationTypeForSource(source);
    if (!type || !modifierState || !Array.isArray(modifierState.internationalOrganizations)) return null;
    return modifierState.internationalOrganizations.find((organization) => organization && organization.type === type) || null;
  }

  function lawStateForSource(source, modifierState) {
    const organization = matchingOrganization(source, modifierState);
    if (organizationTypeForSource(source)) {
      return {
        laws: (organization && organization.laws) || {},
        lawHistory: (organization && organization.lawHistory) || null,
      };
    }
    return {
      laws: modifierState && modifierState.laws && typeof modifierState.laws === "object" ? modifierState.laws : {},
      lawHistory: modifierState && modifierState.lawHistory && typeof modifierState.lawHistory === "object" ? modifierState.lawHistory : null,
    };
  }

  function classifySource(source, modifierState) {
    const tracked = TRACKED_FOLDERS.has(source.folder);
    if (!tracked) return { tracked: false, active: null, status: "untracked", currentChoice: null };
    if (!modifierState || typeof modifierState !== "object") {
      return { tracked: true, active: null, status: "state-unavailable", currentChoice: null };
    }

    const identity = sourceIdentity(source);
    let active = false;
    let currentChoice = null;
    if (source.folder === "advances") active = asSet(modifierState.researchedAdvances).has(identity.choice);
    if (source.folder === "estate_privileges") active = asSet(modifierState.estatePrivileges).has(identity.choice);
    if (source.folder === "government_reforms") active = asSet(modifierState.governmentReforms).has(identity.choice);
    if (source.folder === "laws") {
      const laws = lawStateForSource(source, modifierState).laws;
      currentChoice = typeof laws[identity.group] === "string" ? laws[identity.group] : null;
      active = currentChoice === identity.choice;
    }
    return { tracked: true, active, status: active ? "active" : "candidate", currentChoice };
  }

  function result(state, reason) {
    return { state, reasons: reason ? [reason] : [] };
  }

  function combineAnd(results) {
    const failed = results.find((entry) => entry.state === "blocked");
    if (failed) return failed;
    const unknown = results.filter((entry) => entry.state === "unknown");
    if (unknown.length) return { state: "unknown", reasons: unknown.flatMap((entry) => entry.reasons) };
    return { state: "eligible", reasons: [] };
  }

  function combineOr(results) {
    if (results.some((entry) => entry.state === "eligible")) return { state: "eligible", reasons: [] };
    const unknown = results.filter((entry) => entry.state === "unknown");
    if (unknown.length) return { state: "unknown", reasons: unknown.flatMap((entry) => entry.reasons) };
    return results[0] || result("blocked", "No alternative requirement passed");
  }

  function invert(entry) {
    if (entry.state === "unknown") return entry;
    return entry.state === "eligible" ? result("blocked", "An excluded condition is present") : result("eligible");
  }

  function describeId(value) {
    return String(withoutScope(value) || "required value").replace(/_/g, " ");
  }

  function unlockResult(kind, id, context) {
    id = withoutScope(id);
    const state = context.state;
    const variables = asSet(state.variableKeys);
    const prefix = Object.values(UNLOCK_TRIGGER_KINDS).find((entry) => entry[0] === kind)[1];
    if (variables.has(prefix + id)) return result("eligible");

    const unlockIndex = context.eligibilityData.unlockIndex || {};
    const advances = unlockIndex[kind] && unlockIndex[kind][id];
    if (Array.isArray(advances) && advances.some((advance) => context.advances.has(advance))) return result("eligible");
    if (kind === "law" && Object.prototype.hasOwnProperty.call(context.laws, id)) return result("eligible");
    if (!Array.isArray(state.variableKeys)) return result("unknown", `A new autosave is needed to verify whether ${describeId(id)} is unlocked`);
    return result("blocked", `${describeId(id)} has not been unlocked`);
  }

  function evalScalarTrigger(key, rawValue, context) {
    const state = context.state;
    const target = withoutScope(rawValue);
    if (key === "always") return rawValue === true ? result("eligible") : result("blocked", "This option is disabled by the game definition");
    if (key === "has_advance") return context.advances.has(target) ? result("eligible") : result("blocked", `Requires advance: ${describeId(target)}`);
    if (key === "has_law") return Object.prototype.hasOwnProperty.call(context.laws, target) ? result("eligible") : result("blocked", `Requires law group: ${describeId(target)}`);
    if (key === "has_policy") return Object.values(context.laws).includes(target) ? result("eligible") : result("blocked", `Requires policy: ${describeId(target)}`);
    if (key === "has_reform") return context.reforms.has(target) ? result("eligible") : result("blocked", `Requires reform: ${describeId(target)}`);
    if (key === "has_variable") {
      if (!Array.isArray(state.variableKeys)) return result("unknown", `A new autosave is needed to check variable: ${describeId(target)}`);
      return context.variables.has(target) ? result("eligible") : result("blocked", `Missing unlock flag: ${describeId(target)}`);
    }
    if (key === "has_or_had_tag" || key === "tag" || key === "original_tag") {
      // "tag" (COUNTRYTAG_TRIGGER, "Is $NAME$") is current-tag-only - a
      // country that tag-switched away (e.g. Castile -> Spain) no longer
      // matches tag=CAS even though it did originally. That's a distinct,
      // narrower trigger from "has_or_had_tag" (HAS_OR_HAD_TAG_TRIGGER, "Is
      // or was $NAME$"), verified against the game's own
      // triggers_l_english.yml - they must not share a match set.
      const known = key === "original_tag" ? [context.originalTag] : key === "tag" ? [context.currentTag] : [context.currentTag, context.originalTag];
      if (known.filter(Boolean).includes(target)) return result("eligible");
      const needsCurrent = key !== "original_tag";
      const needsOriginal = key !== "tag";
      if ((needsCurrent && !context.currentTag) || (needsOriginal && !context.originalTag)) {
        return result("unknown", `A new autosave is needed to verify the ${target} country-history requirement`);
      }
      return result("blocked", key === "tag" ? `Restricted to ${target}` : `Restricted to ${target} or a country descended from it`);
    }
    if (key === "religion") {
      if (!state.primaryReligion) return result("unknown", `A new autosave is needed to verify religion: ${describeId(target)}`);
      return state.primaryReligion === target ? result("eligible") : result("blocked", `Requires religion: ${describeId(target)}`);
    }
    if (key === "government_type") {
      if (!state.governmentType) return result("unknown", `A new autosave is needed to verify government type: ${describeId(target)}`);
      return state.governmentType === target ? result("eligible") : result("blocked", `Requires government type: ${describeId(target)}`);
    }
    if (key === "current_age") {
      if (!context.currentAge) return result("unknown", `Could not determine the current age for ${describeId(target)}`);
      return context.currentAge === target ? result("eligible") : result("blocked", `Requires current age: ${describeId(target)}`);
    }
    if (key === "is_leader_of_international_organization") {
      const type = withoutScope(rawValue);
      if (!Array.isArray(state.internationalOrganizations)) return result("unknown", "A new autosave is needed to verify international-organization leadership");
      const organization = state.internationalOrganizations.find((entry) => entry && entry.type === type);
      return organization && organization.leader ? result("eligible") : result("blocked", `Requires leadership of: ${describeId(type)}`);
    }
    if (key === "culture.language") {
      const culture = context.cultures[state.primaryCulture];
      if (!state.primaryCulture || !culture) return result("unknown", `A new autosave is needed to verify language: ${describeId(target)}`);
      return culture.language === target ? result("eligible") : result("blocked", `Requires language: ${describeId(target)}`);
    }
    if (key === "international_organization_type") {
      // Membership only (INTERNATIONAL_ORGANIZATION_TYPE_TRIGGER, "Is a
      // $IO_TYPE$") - verified against real HRE law groups in
      // game/in_game/common/laws/20_hre.txt, whose top-level `potential` is
      // bare `international_organization_type = ...` with no leadership
      // clause; leadership-only variants use the separate
      // is_leader_of_international_organization key (handled above), always
      // inside a choice's own potential_trigger (impactPotential), never
      // this membership gate. Requiring leadership here wrongly blocked the
      // whole law group's eligibility for every ordinary member.
      if (!Array.isArray(state.internationalOrganizations)) return result("unknown", "A new autosave is needed to verify international-organization membership");
      const organization = state.internationalOrganizations.find((entry) => entry && entry.type === target);
      return organization ? result("eligible") : result("blocked", `Requires membership in: ${describeId(target)}`);
    }
    if (Object.prototype.hasOwnProperty.call(context.booleanModifierSources, key)) {
      if (rawValue !== true && rawValue !== false) return result("unknown", `Unsupported modifier comparison: ${key}`);
      const providers = context.booleanModifierSources[key];
      if (!Array.isArray(providers) || !providers.length) return result("unknown", `No source mapping is available for modifier: ${describeId(key)}`);
      const active = providers.some((provider) => {
        if (provider.folder === "advances") return context.advances.has(provider.choice);
        if (provider.folder === "government_reforms") return context.reforms.has(provider.choice);
        if (provider.folder === "estate_privileges") return context.privileges.has(provider.choice);
        if (provider.folder === "laws") return context.laws[provider.group] === provider.choice;
        return false;
      });
      const passed = rawValue ? active : !active;
      return passed ? result("eligible") : result("blocked", `Requires active source: ${describeId(providers[0].choice)}`);
    }
    return result("unknown", `Unsupported game trigger: ${key}`);
  }

  function evalCulture(rawValue, context) {
    const primary = context.state.primaryCulture;
    if (!primary) return result("unknown", "A new autosave is needed to verify the primary culture requirement");
    if (typeof rawValue === "string") {
      const target = withoutScope(rawValue);
      return primary === target ? result("eligible") : result("blocked", `Requires culture: ${describeId(target)}`);
    }
    if (!rawValue || typeof rawValue !== "object") return result("unknown", "Unsupported culture requirement");
    const culture = context.cultures[primary];
    if (!culture) return result("unknown", `Culture metadata is unavailable for ${describeId(primary)}`);
    if (rawValue.has_culture_group) {
      const group = withoutScope(rawValue.has_culture_group);
      return (culture.groups || []).includes(group) ? result("eligible") : result("blocked", `Requires culture group: ${describeId(group)}`);
    }
    if (rawValue.merged_culture_group_contains_culture) {
      const target = withoutScope(rawValue.merged_culture_group_contains_culture);
      if (primary === target) return result("eligible");
      // A primary culture that resolves to an ordinary static definition is
      // not a player-created merged culture, so a different culture cannot
      // be hidden inside it. Dynamic merged cultures have no static entry;
      // those remain unknown until their member list is captured.
      if (context.cultures[primary]) return result("blocked", `Requires a culture merged from: ${describeId(target)}`);
      return result("unknown", `Merged culture membership for ${describeId(target)} is not recorded in the save`);
    }
    return result("unknown", "Unsupported nested culture trigger");
  }

  function evalPredicate(key, rawValue, context, parentMode) {
    if (Array.isArray(rawValue)) {
      const checks = rawValue.map((value) => evalPredicate(key, value, context, parentMode));
      return parentMode === "or" ? combineOr(checks) : combineAnd(checks);
    }
    if (key === "OR") return evalNode(rawValue, context, "or");
    if (key === "NOR") return invert(evalNode(rawValue, context, "or"));
    if (key === "NOT") return invert(evalNode(rawValue, context, "and"));
    if (key === "culture") return evalCulture(rawValue, context);
    if (key === "__items" || key === "?") return result("unknown", "A numeric or conditional game trigger is not supported yet");
    if (UNLOCK_TRIGGER_KINDS[key]) {
      const id = rawValue && typeof rawValue === "object" ? rawValue.type : rawValue;
      if (typeof id !== "string") return result("unknown", `Unsupported game trigger: ${key}`);
      return unlockResult(UNLOCK_TRIGGER_KINDS[key][0], id, context);
    }
    if (rawValue && typeof rawValue === "object") return result("unknown", `Unsupported nested game trigger: ${key}`);
    return evalScalarTrigger(key, rawValue, context);
  }

  function evalNode(node, context, mode) {
    if (!node || typeof node !== "object") return result("unknown", "Malformed game trigger");
    if (Array.isArray(node)) {
      const checks = node.map((entry) => evalNode(entry, context, mode));
      return mode === "or" ? combineOr(checks) : combineAnd(checks);
    }
    const checks = Object.entries(node).map(([key, value]) => evalPredicate(key, value, context, mode));
    return mode === "or" ? combineOr(checks) : combineAnd(checks);
  }

  function currentAge(currentDate, ageYears) {
    const year = parseInt(String(currentDate || "").split(".")[0], 10);
    if (!Number.isFinite(year)) return null;
    let found = null;
    let foundYear = -Infinity;
    for (const [age, startYear] of Object.entries(ageYears || {})) {
      if (typeof startYear === "number" && startYear <= year && startYear > foundYear) {
        found = age;
        foundYear = startYear;
      }
    }
    return found;
  }

  function dateOrdinal(value) {
    const parts = String(value || "").split(".").map((part) => parseInt(part, 10));
    if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return null;
    const monthLengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let day = parts[0] * 365 + parts[2] - 1;
    for (let month = 1; month < parts[1]; month++) day += monthLengths[month - 1] || 0;
    return day;
  }

  function eligibilityContext(scanResult, country) {
    const state = (country && country.modifierState) || {};
    const eligibilityData = scanResult.eligibilityData || {};
    return {
      state,
      eligibilityData,
      advances: asSet(state.researchedAdvances),
      reforms: asSet(state.governmentReforms),
      privileges: asSet(state.estatePrivileges),
      variables: asSet(state.variableKeys),
      laws: state.laws && typeof state.laws === "object" ? state.laws : {},
      cultures: eligibilityData.cultures || {},
      booleanModifierSources: eligibilityData.booleanModifierSources || {},
      currentTag: state.currentTag || (country && country.tag) || null,
      originalTag: state.originalTag || (country && country.originalTag) || null,
      currentAge: currentAge((country && country.currentDate) || state.currentDate, eligibilityData.ageYears),
    };
  }

  function evaluateEligibility(source, scanResult, country) {
    if (!country || !country.modifierState) return result("unknown", "No modifier state is available from the latest autosave");
    const context = eligibilityContext(scanResult, country);
    const definition = source.eligibility;
    if (!definition) return result("unknown", "No eligibility definition was captured for this source");
    const checks = [];

    if (definition.age) {
      const neededYear = context.eligibilityData.ageYears && context.eligibilityData.ageYears[definition.age];
      const currentYear = parseInt(String(country.currentDate || "").split(".")[0], 10);
      if (!Number.isFinite(neededYear) || !Number.isFinite(currentYear)) checks.push(result("unknown", `Could not evaluate age: ${describeId(definition.age)}`));
      else if (currentYear < neededYear) checks.push(result("blocked", `Unlocks in ${describeId(definition.age)} (${neededYear})`));
    }
    for (const advance of definition.requires || []) {
      if (!context.advances.has(advance)) checks.push(result("blocked", `Requires advance: ${describeId(advance)}`));
    }
    if (definition.estate) {
      if (!Array.isArray(context.state.estateTypes)) checks.push(result("unknown", "Active estates are not available from this snapshot"));
      else if (!context.state.estateTypes.includes(definition.estate)) checks.push(result("blocked", `Requires active estate: ${describeId(definition.estate)}`));
    }
    if (definition.godReligion) {
      if (!context.state.primaryReligion) checks.push(result("unknown", "A new autosave is needed to verify the primary religion requirement"));
      else if (context.state.primaryReligion !== definition.godReligion) checks.push(result("blocked", `Requires primary religion: ${describeId(definition.godReligion)}`));
    }
    for (const node of definition.potential || []) checks.push(evalNode(node, context, "and"));
    for (const node of definition.allow || []) checks.push(evalNode(node, context, "and"));

    const identity = sourceIdentity(source);
    const unlockIndex = context.eligibilityData.unlockIndex || {};
    if (source.folder === "laws" && unlockIndex.law && unlockIndex.law[identity.group] && !Object.prototype.hasOwnProperty.call(context.laws, identity.group)) {
      checks.push(unlockResult("law", identity.group, context));
    }
    if (source.folder === "laws" && unlockIndex.policy && unlockIndex.policy[identity.choice]) {
      checks.push(unlockResult("policy", identity.choice, context));
    }
    const sourceLawState = lawStateForSource(source, context.state);
    if (source.folder === "laws" && identity.group && sourceLawState.laws[identity.group]) {
      if (!sourceLawState.lawHistory) {
        checks.push(result("unknown", "A new autosave is needed to verify the law-change cooldown"));
      } else {
        const history = sourceLawState.lawHistory[identity.group];
        if (history && typeof history.days === "number") {
          const changedOn = dateOrdinal(history.date);
          const today = dateOrdinal(country.currentDate);
          if (changedOn === null || today === null) checks.push(result("unknown", "The law-change cooldown date could not be read"));
          else if (today - changedOn < history.days) checks.push(result("blocked", `Law change cooldown: ${history.days - (today - changedOn)} days remaining`));
        }
      }
    }

    return combineAnd(checks);
  }

  function compareSources(a, b) {
    if (a.folder === "estate_privileges" && b.folder === "estate_privileges") {
      const estateOrder = String(a.estateLabel || a.estate || "").localeCompare(String(b.estateLabel || b.estate || ""));
      if (estateOrder) return estateOrder;
      const aCost = typeof a.estatePowerCost === "number" ? a.estatePowerCost : Infinity;
      const bCost = typeof b.estatePowerCost === "number" ? b.estatePowerCost : Infinity;
      if (aCost !== bCost) return aCost - bCost;
    }
    const av = typeof a.resolvedValue === "number" ? a.resolvedValue : -Infinity;
    const bv = typeof b.resolvedValue === "number" ? b.resolvedValue : -Infinity;
    return bv - av || String(a.category || a.folder).localeCompare(String(b.category || b.folder)) || String(a.entity || a.bundleId).localeCompare(String(b.entity || b.bundleId));
  }

  function buildModifierReport(scanResult, country) {
    if (!scanResult || !Array.isArray(scanResult.direct)) throw new Error("Invalid modifier scan result.");
    const modifierState = country && country.modifierState;
    const valueFormat = String(scanResult.modifierKey || "").startsWith("monthly_towards_") ? "monthly_points" : "percent";
    const directSources = scanResult.direct
      .filter((source) => !(source.folder === "auto_modifiers" && MODELED_AUTOMATIC_ENTITIES.has(source.entity)))
      .concat(societalDynamicSources(scanResult.modifierKey, modifierState));
    const activeEstateIds = modifierState && Array.isArray(modifierState.estateTypes) ? modifierState.estateTypes : null;
    const estateLabels = new Map(
      directSources
        .filter((source) => source.estate && source.estateLabel)
        .map((source) => [source.estate, source.estateLabel])
    );
    const rows = directSources.map((source) => {
      const dynamicClassification = classifyDynamicSource(source, modifierState);
      let classified = dynamicClassification || classifySource(source, modifierState);
      if (classified.active === true && source.impactPotential) {
        const impact = evalNode(source.impactPotential, eligibilityContext(scanResult, country), "and");
        if (impact.state !== "eligible") classified = { tracked: false, active: null, status: "condition-not-active", currentChoice: null };
      }
      const eligibility = classified.active === false ? evaluateEligibility(source, scanResult, country) : null;
      const resolvedValue = dynamicClassification && dynamicClassification.sourceCount && typeof source.resolvedValue === "number" ? source.resolvedValue * dynamicClassification.sourceCount : source.resolvedValue;
      return Object.assign({}, source, { valueFormat, resolvedValue }, sourceIdentity(source), sourceCategory(source), classified, eligibility ? { eligibilityState: eligibility.state, eligibilityReasons: eligibility.reasons } : {});
    });
    const positive = rows.filter((row) => typeof row.resolvedValue === "number" && row.resolvedValue > 0);
    const inactiveTracked = positive.filter((row) => row.tracked && row.active === false);
    const recommendations = inactiveTracked.filter((row) => row.eligibilityState === "eligible").sort(compareSources);
    const blockedSources = inactiveTracked.filter((row) => row.eligibilityState === "blocked").sort(compareSources);
    const unknownSources = inactiveTracked.filter((row) => row.eligibilityState === "unknown").sort(compareSources);
    const activeSources = rows.filter((row) => row.active === true).sort(compareSources);
    const otherSources = positive.filter((row) => row.active !== true && (!row.tracked || row.active === null)).sort(compareSources);
    const knownActiveContribution = activeSources.reduce((sum, row) => sum + (typeof row.resolvedValue === "number" ? row.resolvedValue : 0), 0);
    const positiveBundles = (scanResult.bundles || []).filter((row) => !MODELED_AUTOMATIC_ENTITIES.has(row.bundleId) && (typeof row.resolvedValue !== "number" || row.resolvedValue > 0));
    const eventSources = [];
    const otherIndirectSources = [];
    for (const bundle of positiveBundles) {
      const grantors = Array.isArray(bundle.grantors) ? bundle.grantors : [];
      const eventGrantors = grantors.filter((grantor) => grantor.category === "events");
      if (eventGrantors.length) eventSources.push(indirectSource(bundle, "events", eventGrantors, valueFormat));

      const nonEventGrantors = grantors.filter((grantor) => grantor.category !== "events");
      if (!grantors.length) otherIndirectSources.push(indirectSource(bundle, "scripted", [], valueFormat));
      else {
        for (const category of [...new Set(nonEventGrantors.map((grantor) => grantor.category))]) {
          otherIndirectSources.push(indirectSource(bundle, category, nonEventGrantors.filter((grantor) => grantor.category === category), valueFormat));
        }
      }
    }
    eventSources.sort(compareSources);
    otherIndirectSources.sort(compareSources);

    return {
      modifierKey: scanResult.modifierKey,
      valueFormat,
      generatedFrom: scanResult.generatedFrom,
      country: country
        ? {
            number: country.number,
            tag: country.tag,
            players: country.players || [],
            stateKnown: !!modifierState,
            activeEstates: activeEstateIds
              ? activeEstateIds.map((id) => ({ id, label: estateLabels.get(id) || null }))
              : null,
          }
        : null,
      knownActiveContribution,
      recommendations,
      blockedSources,
      unknownSources,
      activeSources,
      otherSources,
      eventSources,
      otherIndirectSources,
      indirectBundles: positiveBundles.sort(compareSources),
      optimizationIncludesTemporaryEvents: false,
    };
  }

  function buildSocietalEquilibrium(selectedReport, opposingReport, selectedDirectionId, opposingDirectionId) {
    const selectedRate = selectedReport && typeof selectedReport.knownActiveContribution === "number" ? selectedReport.knownActiveContribution : 0;
    const opposingRate = opposingReport && typeof opposingReport.knownActiveContribution === "number" ? opposingReport.knownActiveContribution : 0;
    const netRate = selectedRate - opposingRate;
    return {
      selectedRate,
      opposingRate,
      netRate,
      directionId: netRate < 0 ? opposingDirectionId : selectedDirectionId,
      position: Math.abs(netRate * 100),
    };
  }

  return { TRACKED_FOLDERS, SOURCE_CATEGORIES, sourceIdentity, classifySource, evaluateEligibility, buildModifierReport, buildSocietalEquilibrium };
});
