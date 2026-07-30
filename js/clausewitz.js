// Streaming parser for melted (plaintext) Paradox Clausewitz save files (EU5).
//
// The format is a whitespace-delimited key/value script:
//   key=value
//   key={ ... }              (nested object, or array if entries have no "=")
//   key="quoted string"      (\" and \\ escapes supported)
//
// A full generic parse of an entire EU5 save (hundreds of MB) into JS objects
// would be too slow/memory-heavy, and most of the file (military units, AI
// memory, character DB, war history, ...) isn't needed for summary stats. So
// this module walks the file once at the top level, and for each top-level
// key either:
//   - fully parses it (small sections: metadata, played_country, ...), or
//   - parses it with custom per-entry logic that discards each entry after
//     extracting the handful of fields we care about (countries.database), or
//   - skips over it without allocating anything (everything else).
//
// Works in both Node (for testing) and the browser (no environment-specific
// APIs are used below the parseSave() entry point).

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Clausewitz = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function isWhitespace(ch) {
    return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
  }

  const INT_RE = /^-?\d+$/;
  const FLOAT_RE = /^-?\d+\.\d+$/;
  const DATE_RE = /^\d{1,5}\.\d{1,2}\.\d{1,2}(\.\d{1,2})?$/;

  function coerceScalar(raw) {
    if (raw === "yes") return true;
    if (raw === "no") return false;
    if (INT_RE.test(raw)) return parseInt(raw, 10);
    if (FLOAT_RE.test(raw)) return parseFloat(raw);
    if (DATE_RE.test(raw)) return raw; // keep dates as sortable "Y.M.D[.H]" strings
    return raw;
  }

  // Structural-char finder reused across skipValue() calls instead of being
  // reallocated per call.
  const STRUCTURAL_RE = /["{}]/g;

  class Scanner {
    constructor(text, pos, end) {
      this.text = text;
      this.pos = pos || 0;
      this.end = end === undefined ? text.length : end;
    }

    eof() {
      return this.pos >= this.end;
    }

    peekChar() {
      return this.text[this.pos];
    }

    skipWs() {
      const t = this.text;
      while (this.pos < this.end && isWhitespace(t[this.pos])) this.pos++;
    }

    consumeIfPresent(ch) {
      this.skipWs();
      if (this.text[this.pos] === ch) {
        this.pos++;
        return true;
      }
      return false;
    }

    // Reads one raw scalar token: a quoted string (escapes resolved) or a
    // bare identifier/number/date, stopping before whitespace/{ / } / =.
    // Does not handle '{' / '}' - callers check peekChar() for those first.
    readScalarToken() {
      this.skipWs();
      const t = this.text;
      if (t[this.pos] === '"') {
        this.pos++;
        let out = "";
        let sliceStart = this.pos;
        while (this.pos < this.end) {
          const ch = t[this.pos];
          if (ch === "\\") {
            out += t.slice(sliceStart, this.pos) + t[this.pos + 1];
            this.pos += 2;
            sliceStart = this.pos;
            continue;
          }
          if (ch === '"') {
            out += t.slice(sliceStart, this.pos);
            this.pos++;
            return { raw: out, isString: true };
          }
          this.pos++;
        }
        out += t.slice(sliceStart, this.pos);
        return { raw: out, isString: true }; // unterminated; be lenient
      }

      const start = this.pos;
      while (this.pos < this.end) {
        const ch = t[this.pos];
        if (isWhitespace(ch) || ch === "{" || ch === "}" || ch === "=") break;
        this.pos++;
      }
      return { raw: t.slice(start, this.pos), isString: false };
    }

    // Parses whatever comes next: a nested block ({...}) or a scalar value.
    parseValue() {
      this.skipWs();
      if (this.text[this.pos] === "{") {
        this.pos++;
        return this.parseBlockBody();
      }
      return this._finishScalar(this.readScalarToken());
    }

    // Given a scalar token just read (not a '{'), resolves it to its final
    // value - either a plain scalar, or (if immediately followed by a block)
    // a tagged compound value like "rgb { 0 104 166 }" / "hsv { ... }".
    _finishScalar(tok) {
      if (!tok.isString) {
        const savedPos = this.pos;
        this.skipWs();
        if (this.text[this.pos] === "{") {
          this.pos++;
          return { tag: tok.raw, values: this.parseBlockBody() };
        }
        this.pos = savedPos;
      }
      return tok.isString ? tok.raw : coerceScalar(tok.raw);
    }

    // Assumes the opening '{' has already been consumed. Real save data
    // mixes three kinds of block content, sometimes within the same block
    // (e.g. "duration={ 1 0=255 }"), so this parses in a single unified
    // pass rather than pre-deciding "object" vs "array":
    //   - key=value pairs                -> named entries
    //   - bare nested blocks / scalars    -> positional items
    // Returns: {} for empty blocks, a plain array if only positional items
    // were found, a plain object if only named entries were found, or (rare)
    // an object with a `__items` array alongside named entries if both were
    // present.
    parseBlockBody() {
      this.skipWs();
      if (this.text[this.pos] === "}") {
        this.pos++;
        return {};
      }

      const items = [];
      const named = {};
      let hasNamed = false;

      while (true) {
        this.skipWs();
        if (this.text[this.pos] === "}") {
          this.pos++;
          break;
        }
        if (this.eof()) break;

        if (this.text[this.pos] === "{") {
          this.pos++;
          items.push(this.parseBlockBody());
          continue;
        }

        const beforePos = this.pos;
        const tok = this.readScalarToken();
        if (this.pos === beforePos) {
          // Unrecognized character where a token was expected; skip it so
          // we always make forward progress instead of hanging.
          this.pos++;
          continue;
        }

        this.skipWs();
        if (this.text[this.pos] === "=") {
          this.pos++;
          this._addEntry(named, tok.raw, this.parseValue());
          hasNamed = true;
        } else {
          items.push(this._finishScalar(tok));
        }
      }

      if (!hasNamed) return items;
      if (items.length === 0) return named;
      named.__items = items;
      return named;
    }

    _addEntry(obj, key, val) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        if (Array.isArray(obj[key])) obj[key].push(val);
        else obj[key] = [obj[key], val];
      } else {
        obj[key] = val;
      }
    }

    // Skips over the next value (scalar or block) without allocating any
    // structure, for top-level sections we don't care about. Uses a regex
    // to jump between structural characters instead of a char-by-char loop.
    skipValue() {
      this.skipWs();
      if (this.text[this.pos] !== "{") {
        this.readScalarToken();
        return;
      }
      this.pos++;
      let depth = 1;
      const t = this.text;
      const re = STRUCTURAL_RE;
      while (depth > 0) {
        re.lastIndex = this.pos;
        const m = re.exec(t);
        if (!m || m.index >= this.end) {
          this.pos = this.end;
          return;
        }
        if (m[0] === '"') {
          let i = m.index + 1;
          while (i < this.end) {
            if (t[i] === "\\") {
              i += 2;
              continue;
            }
            if (t[i] === '"') {
              i++;
              break;
            }
            i++;
          }
          this.pos = i;
        } else if (m[0] === "{") {
          depth++;
          this.pos = m.index + 1;
        } else {
          depth--;
          this.pos = m.index + 1;
        }
      }
    }
  }

  // Fields pulled out of each countries.database entry. Kept intentionally
  // small - the country blocks also contain deep AI/parliament/mission trees
  // we don't need for summary stats, and are discarded immediately after
  // extraction so peak memory stays roughly proportional to one country
  // block at a time, not the whole (multi-GB parsed) countries section.
  function enabledObjectKeys(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    return Object.entries(value)
      .filter(([key, enabled]) => key !== "__items" && (enabled === true || enabled === "yes" || enabled === 1))
      .map(([key]) => key);
  }

  function historyObjectIds(value) {
    const entries = Array.isArray(value) ? value : value && Array.isArray(value.__items) ? value.__items : [];
    return entries.map((entry) => entry && entry.object).filter((id) => typeof id === "string");
  }

  function implementedLawChoices(value) {
    const out = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return out;
    for (const [law, history] of Object.entries(value)) {
      if (law === "__items") continue;
      const entries = Array.isArray(history) ? history : [history];
      const latest = entries[entries.length - 1];
      if (latest && typeof latest.object === "string") out[law] = latest.object;
    }
    return out;
  }

  const EU5_MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  function normalizeEu5Date(value) {
    if (typeof value === "string") return value;
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    const hourOfDay = value % 24;
    const totalDays = (value - hourOfDay) / 24;
    const yearPlus5000 = Math.floor(totalDays / 365);
    let day = totalDays - yearPlus5000 * 365;
    const year = yearPlus5000 - 5000;
    let month = 0;
    while (month < EU5_MONTH_LENGTHS.length - 1 && day >= EU5_MONTH_LENGTHS[month]) day -= EU5_MONTH_LENGTHS[month++];
    const base = `${year}.${month + 1}.${day + 1}`;
    return hourOfDay === 0 ? base : `${base}.${hourOfDay}`;
  }

  function implementedLawHistory(value) {
    const out = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return out;
    for (const [law, history] of Object.entries(value)) {
      if (law === "__items") continue;
      const entries = Array.isArray(history) ? history : [history];
      const latest = entries[entries.length - 1];
      if (!latest || typeof latest.object !== "string") continue;
      out[law] = {
        choice: latest.object,
        date: normalizeEu5Date(latest.date),
        days: typeof latest.days === "number" ? latest.days : null,
      };
    }
    return out;
  }

  function variableKeys(value) {
    const data = value && value.data;
    const entries = Array.isArray(data) ? data : data && Array.isArray(data.__items) ? data.__items : [];
    return entries.map((entry) => entry && entry.flag).filter((flag) => typeof flag === "string");
  }

  function societalValuePositions(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out = {};
    for (const [axis, position] of Object.entries(value)) {
      if (axis === "__items" || typeof position !== "number" || !Number.isFinite(position) || position <= -999) continue;
      out[axis] = position;
    }
    return out;
  }

  function extractInternationalOrganizationFields(number, obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj) || typeof obj.type !== "string") return null;
    return {
      number,
      type: obj.type,
      leader: typeof obj.leader === "number" ? obj.leader : null,
      members: Array.isArray(obj.all_members) ? obj.all_members.filter((member) => typeof member === "number") : [],
      laws: implementedLawChoices(obj.implemented_laws),
      lawHistory: implementedLawHistory(obj.implemented_laws),
    };
  }

  function extractCountryFields(number, obj, includeModifierState) {
    const score = obj.score || {};
    const rating = score.score_rating || {};
    const rank = score.score_rank || {};
    const currency = obj.currency_data || {};
    const government = obj.government || {};
    const economy = obj.economy || {};
    const color = obj.color && Array.isArray(obj.color.values) ? obj.color.values : null;

    const country = {
      number,
      tag: typeof obj.country_name === "string" ? obj.country_name : String(obj.flag || ""),
      originalTag: typeof obj.original_tag === "string" ? obj.original_tag : null,
      countryType: obj.country_type,
      level: obj.level,
      capital: obj.capital,
      color: color ? `rgb(${color[0]}, ${color[1]}, ${color[2]})` : null,
      scorePlace: score.score_place,
      admScore: rating.ADM,
      dipScore: rating.DIP,
      milScore: rating.MIL,
      admRank: rank.ADM,
      dipRank: rank.DIP,
      milRank: rank.MIL,
      gold: currency.gold,
      manpower: currency.manpower,
      sailors: currency.sailors,
      stability: currency.stability,
      prestige: currency.prestige,
      armyTradition: currency.army_tradition,
      navyTradition: currency.navy_tradition,
      religiousInfluence: currency.religious_influence,
      inflation: currency.inflation,
      totalProduced: obj.total_produced,
      // `last_month_gold_income` is absent entirely from at least one real
      // older save (confirmed: 1.0.11, "Sindh" campaign - 0 of 2456 "Real"
      // countries had it, vs. economy.income/expense both present and
      // driving Profit correctly) - either this exact field didn't exist
      // yet that early, or its fixed ID differs from the 1.1.x-1.3.x saves
      // this project's ID table was built from (no melted copy of a 1.0.11
      // save exists to cross-check the version-specific ID and fix it
      // properly). `economy.income` (gross income, already extracted
      // separately below) is confirmed within ~1-2% of `last_month_gold_
      // income` on every save that has both fields, so it's used as the
      // fallback here rather than leaving Income/mo blank for saves this
      // old.
      lastMonthGoldIncome: typeof obj.last_month_gold_income === "number" ? obj.last_month_gold_income : economy.income,
      lastMonthManpowerIncome: obj.last_month_manpower_income,
      lastMonthSailorsIncome: obj.last_month_sailors_income,
      maxManpower: obj.max_manpower,
      maxSailors: obj.max_sailors,
      governmentType: government.type,
      courtLanguage: obj.court_language,
      aiPersonality: obj.ai_personality,
      // Economy
      income: economy.income,
      expense: economy.expense,
      taxRates: economy.tax_rates && typeof economy.tax_rates === "object" ? economy.tax_rates : null,
      creditworthiness: economy.creditworthiness,
      loanCapacity: economy.loan_capacity,
      coinMinting: economy.coin_minting,
      monthlyGoldTrend: Array.isArray(economy.monthly_gold) ? economy.monthly_gold : null,
      lastMonthsTaxIncome: obj.last_months_tax_income,
      // The government's actual share of merchant-route profit for the last
      // completed month. This is a country-level treasury value, unlike
      // estate_manager.*.last_month.trade_income, which belongs to each
      // estate's private gold pool. Current binary saves encode this key as
      // fixed token 0x36f8 (resolved in eu5-fixed-ids.js); retain the direct
      // fallback so this extractor is also safe when used with an older or
      // partial resolver.
      lastMonthsTradeIncome:
        typeof obj.last_months_trade_income === "number"
          ? obj.last_months_trade_income
          : typeof obj["#36f8"] === "number"
            ? obj["#36f8"]
            : undefined,
      lastMonthsManpowerExpense: obj.last_months_manpower_expense,
      lastMonthsSailorExpense: obj.last_months_sailor_expense,
      lastMonthsSubjectTax: obj.last_months_subject_tax,
      lastMonthsArmyMaintenance: obj.last_months_army_maintenance,
      lastMonthsNavyMaintenance: obj.last_months_navy_maintenance,
      lastMonthsFortMaintenance: obj.last_months_fort_maintenance,
      lastMonthsBuildingMaintenance: obj.last_months_building_maintenance,
      // Military / standing
      expectedArmySize: obj.expected_army_size,
      expectedNavySize: obj.expected_navy_size,
      greatPowerRank: obj.great_power_rank,
      regionalPower: obj.regional_power,
      // Culture / religion (numeric IDs - no name lookup table shipped yet)
      primaryCulture: obj.primary_culture,
      primaryReligion: obj.primary_religion,
      locationCount: Array.isArray(obj.owned_locations) ? obj.owned_locations.length : 0,
      // The actual location IDs, not just the count - used by the recorder's
      // land-transfer signal (llama-log-machine.js's sideEconomyDeltas) to
      // tell "this exact province moved to the enemy" apart from "the same
      // net count, but only because an unrelated internal vassal transfer
      // happened to land at the same moment a war concluded". Kept on every
      // country here (cheap - it's already a fully-decoded array by this
      // point) - the recorder's own countrySummary() is what bounds which
      // countries actually get this field persisted into the ledger.
      ownedLocations: Array.isArray(obj.owned_locations) ? obj.owned_locations : [],
      // Which of the game's own automation-delegation options ("let the AI
      // handle building queues", "let the AI replace dead generals", etc.)
      // are currently enabled for this country. Confirmed on real data (see
      // [[player_session_handling]]): every genuinely AI-only country in a
      // real save carries ONLY the single default entry ("ProductionMethods"),
      // with zero exceptions across a full ~2500-country population, while
      // human players selectively enable a handful of others for
      // convenience - EXCEPT a player who's actually stopped playing, whose
      // country had literally every automation option enabled at once
      // (confirmed real, not theoretical - dramatically more than any
      // actively-played country in the same game). Used by
      // js/llama-score.js's computeAutomationDepartures() as an automatic
      // departed-player signal, alongside the existing manual Hide button.
      automatedSystems: Array.isArray(obj.automated_systems) ? obj.automated_systems : [],
      // Population / historical trends (one entry per in-game year)
      population: obj.last_months_population,
      historicalPopulation: Array.isArray(obj.historical_population) ? obj.historical_population : null,
      historicalTaxBase: Array.isArray(obj.historical_tax_base) ? obj.historical_tax_base : null,
      historicalEconomicalBase: Array.isArray(obj.historical_economical_base) ? obj.historical_economical_base : null,
      players: [],
    };
    if (includeModifierState) {
      country.modifierState = {
        researchedAdvances: enabledObjectKeys(obj.researched_advances),
        laws: implementedLawChoices(government.implemented_laws),
        lawHistory: implementedLawHistory(government.implemented_laws),
        estatePrivileges: historyObjectIds(government.implemented_privileges),
        governmentReforms: historyObjectIds(government.implemented_reforms),
        // government.estates lists every possible slot for the country,
        // including inactive estates. The authoritative active list is
        // attached after estate_manager is parsed (existence=true).
        estateTypes: null,
        variableKeys: variableKeys(obj.variables),
        societalValues: societalValuePositions(government.societal_values),
        acceptedCultures: Array.isArray(obj.accepted_cultures) ? obj.accepted_cultures : [],
        ruler: typeof government.ruler === "number" ? government.ruler : null,
        heir: typeof government.heir === "number" ? government.heir : null,
        consort: typeof government.consort === "number" ? government.consort : null,
        regent: typeof government.regent === "number" ? government.regent : null,
        maintenances: economy.maintenances && typeof economy.maintenances === "object" ? economy.maintenances : {},
        employmentSystem: typeof obj.employment_system === "string" ? obj.employment_system : "first_come_first_serve",
      };
    }
    return country;
  }

  // Real bug found on real data: this used to prefer `population_ratio` as
  // the whole class's headcount whenever present, falling back to summing
  // the employment-state fields (unemployed/employed_in_rgo/
  // employed_in_building/produced) only when it was absent. But
  // `population_ratio` isn't a headcount at all - it's some other ratio/
  // multiplier the game tracks internally, and it systematically UNDER-
  // represents the real total for whichever classes happen to carry it
  // (confirmed: a location's reported population was ~4.8k against an
  // in-game ~30.7k for that exact location; summed across a country's full
  // owned-location set, the same pattern held everywhere - every player
  // country's summed location population landed at just 37-67% of that
  // country's own trusted total). Classes that never carry
  // `population_ratio` at all (peasants, tribesmen, slaves - often the
  // LARGEST classes in rural/tribal locations) were already summing
  // correctly via the fallback path the whole time, which is exactly why
  // this was so easy to miss: only SOME classes were wrong, and never the
  // same ones twice.
  //
  // Fix: always sum the employment-state fields, never population_ratio -
  // verified against real save data by cross-checking the summed
  // owned-location population against each country's own trusted total
  // (last_months_population): every player country now lands within ~2% of
  // its trusted figure (was 37-67%), across 8 different real countries.
  // `population_ratio` itself is left on each class's own record
  // (populationRatio in summarizePopulation below) in case it's useful for
  // something else later - just never used as a total again.
  function popClassTotal(stats) {
    if (!stats || typeof stats !== "object") return undefined;
    let total = 0;
    let found = false;
    for (const key of ["unemployed", "employed_in_rgo", "employed_in_building", "produced"]) {
      if (typeof stats[key] === "number") {
        total += stats[key];
        found = true;
      }
    }
    return found ? total : undefined;
  }

  function summarizePopulation(popObj) {
    const summary = { total: undefined, classes: [], popIds: [] };
    if (!popObj || typeof popObj !== "object") return summary;
    if (Array.isArray(popObj.pops)) summary.popIds = popObj.pops;
    if (!popObj.pop_stats || typeof popObj.pop_stats !== "object") return summary;

    let total = 0;
    for (const [name, stats] of Object.entries(popObj.pop_stats)) {
      if (!stats || typeof stats !== "object") continue;
      const classTotal = popClassTotal(stats);
      if (typeof classTotal === "number") total += classTotal;
      summary.classes.push({
        name,
        total: classTotal,
        populationRatio: stats.population_ratio,
        unemployed: stats.unemployed,
        employedInRgo: stats.employed_in_rgo,
        employedInBuilding: stats.employed_in_building,
        produced: stats.produced,
      });
    }
    summary.total = summary.classes.length ? total : undefined;
    summary.classes.sort((a, b) => (b.total || 0) - (a.total || 0));
    return summary;
  }

  // Fields pulled out of each locations.locations entry. culture/religion/
  // raw_material are numeric IDs/strings in the save (no name lookup table
  // shipped yet - see README roadmap), kept raw for now.
  function extractLocationFields(number, obj) {
    const pop = summarizePopulation(obj.population);
    return {
      number,
      owner: obj.owner,
      controller: obj.controller,
      previousOwner: obj.previous_owner,
      market: obj.market,
      secondBestMarket: obj.second_best_market,
      marketAccess: obj.market_access,
      marketAttraction: obj.market_attraction,
      development: obj.development,
      culture: obj.culture,
      religion: obj.religion,
      secondaryReligion: obj.secondary_religion,
      religiousUnity: obj.religious_unity,
      language: obj.language,
      dialect: obj.dialect,
      rank: obj.rank,
      rawMaterial: obj.raw_material,
      maxRawMaterialWorkers: obj.max_raw_material_workers,
      tax: obj.tax,
      possibleTax: obj.possible_tax,
      estateTax: obj.estate_tax && typeof obj.estate_tax === "object" ? obj.estate_tax : null,
      estatePossibleTax: obj.estate_possible_tax && typeof obj.estate_possible_tax === "object" ? obj.estate_possible_tax : null,
      control: obj.control,
      prosperity: obj.prosperity,
      valueFlow: obj.value_flow,
      province: obj.province,
      institutions: obj.institutions && typeof obj.institutions === "object" ? obj.institutions : null,
      population: pop.total,
      populationClasses: pop.classes,
      popIds: pop.popIds,
      popCount: pop.popIds.length,
    };
  }

  function extractPopFields(number, obj) {
    if (!obj || typeof obj !== "object") return null;
    const size = typeof obj.size === "number" ? obj.size : null;
    if (size === null) return null;
    return {
      number,
      type: obj.type,
      estate: obj.estate || obj["#2e90"],
      culture: obj.culture,
      religion: obj.religion,
      literacy: typeof obj.literacy === "number" ? obj.literacy : null,
      size,
    };
  }

  function extractCharacterSocietalFields(number, obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    const traits = Array.isArray(obj.traits)
      ? obj.traits.filter((trait) => typeof trait === "string")
      : obj.traits && Array.isArray(obj.traits.__items)
        ? obj.traits.__items.filter((trait) => typeof trait === "string")
        : enabledObjectKeys(obj.traits);
    return traits.length ? { number, traits } : null;
  }

  function extractWorkOfArtSocietalFields(number, obj) {
    // A destroyed work of art keeps its database entry (with a
    // destroyed_date) rather than being removed - excluded here so it
    // doesn't inflate/misattribute a country's current artwork-quality
    // share (real save data: ~16% of work_of_art_manager entries carry a
    // destroyed_date).
    if (!obj || typeof obj !== "object" || Array.isArray(obj) || typeof obj.location !== "number" || obj.destroyed_date != null) return null;
    return {
      number,
      location: obj.location,
      quality: typeof obj.quality === "number" && Number.isFinite(obj.quality) ? obj.quality : 1,
    };
  }

  function extractEstateAssetFields(number, obj) {
    if (!obj || typeof obj !== "object") return null;
    return {
      number,
      country: obj.country,
      estateType: obj.estate_type,
      location: obj.location,
      building: obj.building,
      startLocation: obj.start_location,
      endLocation: obj.end_location,
      roadType: obj.road_type,
      rgo: obj.rgo,
      existence: obj.existence,
      // `estate_manager.database` mixes two shapes under one numbering: real
      // location assets (location/building/rgo present) AND, separately, one
      // entry per country per estate type (nobles_estate/clergy_estate/...)
      // carrying a `last_month` income/expense breakdown for that estate.
      // `trade_income` there is that ESTATE's own private trade income (it
      // feeds the estate's own gold/balance, a pool separate from the
      // country's treasury - confirmed on real saves where these entries
      // carry their own `gold`/`balance` fields) - summing it across a
      // country's estates must therefore never be used for the Economy
      // tab's state "Trade Income" column. The real country-level treasury
      // field is last_months_trade_income (binary token 0x36f8), extracted
      // by extractCountryFields above.
      tradeIncome: obj.last_month && typeof obj.last_month.trade_income === "number" ? obj.last_month.trade_income : undefined,
      // `paid_taxes` is the actual gold this estate sent to the crown last
      // month - unlike `trade_income` above, this genuinely is state
      // revenue, not private estate wealth (name and structure line up with
      // the government income ledger's per-estate "Tax at X% from
      // <estate>" lines, paired with the country-level
      // `economy.tax_rates.<estate_type>` already extracted in
      // extractCountryFields - dollar-for-dollar match against that ledger
      // not yet confirmed against a real screenshot, but this is a real
      // save field, not a guess/derived formula like tradeIncome above).
      paidTaxes: obj.last_month && typeof obj.last_month.paid_taxes === "number" ? obj.last_month.paid_taxes : undefined,
    };
  }

  function extractBuildingFields(number, obj) {
    if (!obj || typeof obj !== "object") return null;
    return {
      number,
      type: obj.type,
      level: obj.level,
      employed: obj.employed,
      employmentRequirement: obj.employment_requirement,
      employmentRequirementStatus: obj.employment_requirement_status,
      location: obj.location,
      owner: obj.owner,
      lastMonthsProfit: obj.last_months_profit,
      upkeep: obj.upkeep,
    };
  }

  function colorValueToCss(color) {
    const values = color && Array.isArray(color.values) ? color.values : null;
    return values ? `rgb(${values[0]}, ${values[1]}, ${values[2]})` : null;
  }

  function extractNamedDefinitionFields(number, obj) {
    if (!obj || typeof obj !== "object") return null;
    return {
      number,
      name: typeof obj.name === "string" ? obj.name : typeof obj.key === "string" ? obj.key : String(number),
      key: obj.key,
      definition: obj.definition || obj.culture_definition,
      group: obj.group,
      color: colorValueToCss(obj.color),
    };
  }

  // A market_manager.database entry's two id lists are easily confused:
  // `members` is the list of LOCATION ids belonging to this market (values
  // range over the full 1-28573 location space, clustered around `center`),
  // while `market` is a list of other MARKET numbers this market is linked
  // to (every value stays below the market count, ~121 on a real save) -
  // confirmed by range-checking both lists against a real save. `market`
  // used to be extracted here under the name `locations`, which nothing
  // consumed - renamed to `connectedMarkets` now that the trade-network
  // mapmode actually uses it.
  function extractMarketFields(number, obj) {
    if (!obj || typeof obj !== "object") return null;
    const merchantsRaw = obj.merchant ? (Array.isArray(obj.merchant) ? obj.merchant : [obj.merchant]) : [];
    const merchants = [];
    for (const m of merchantsRaw) {
      if (!m || typeof m !== "object") continue;
      merchants.push({ country: m.country, power: m.power, capacity: m.capacity, used: m.used });
    }
    // Per-good market state, kept compact: the raw entry also carries a
    // huge `impacts` price-modifier list and per-source `supplied`/
    // `demanded`/`taken` breakdowns; only the fields the market-statistics
    // panel actually renders are retained (results are cached in IndexedDB,
    // so dead weight here is paid on every save in the library).
    let goods = null;
    if (obj.goods && typeof obj.goods === "object" && !Array.isArray(obj.goods)) {
      goods = {};
      for (const [name, g] of Object.entries(obj.goods)) {
        if (!g || typeof g !== "object") continue;
        goods[name] = {
          price: g.price,
          supply: g.supply,
          demand: g.demand,
          // Relative price deviation from the good's base price (negative =
          // cheap/oversupplied here, positive = expensive/undersupplied) -
          // the same signal the game's own market UI derives its "high/low
          // price" coloring from, used for the needs/surpluses ranking.
          impact: g.impact,
          stockpile: g.stockpile,
          rgoLocations: g.locations_with_this_as_raw_material,
          // How much of this good arrived from / left for OTHER markets last
          // tick (the Trade component of the supplied/demanded breakdowns).
          tradeIn: g.supplied && typeof g.supplied === "object" ? g.supplied.Trade : undefined,
          tradeOut: g.demanded && typeof g.demanded === "object" ? g.demanded.Trade : undefined,
        };
      }
    }
    return {
      number,
      center: obj.center !== undefined ? obj.center : obj["#32"],
      color: colorValueToCss(obj.color),
      population: obj.population,
      food: obj.food,
      capacity: obj.capacity,
      migrationAttraction: obj.average_migration_attraction,
      memberCount: Array.isArray(obj.members) ? obj.members.length : undefined,
      connectedMarkets: Array.isArray(obj.market) ? obj.market : [],
      merchants,
      goods,
    };
  }

  // One trade_path_manager.database entry: a country's established route
  // carrying goods from one market to another, with the actual location-id
  // waypoint list the route traverses (mostly sea zones for naval routes) -
  // the waypoints are what lets the trade-network mapmode draw flows along
  // their real geography instead of straight lines.
  function extractTradePathFields(number, obj) {
    if (!obj || typeof obj !== "object") return null;
    if (typeof obj.from !== "number" || typeof obj.to !== "number") return null;
    return {
      number,
      country: obj.country,
      from: obj.from,
      to: obj.to,
      cost: obj.cost,
      path: Array.isArray(obj.path) ? obj.path : [],
    };
  }

  // One trade_manager.database entry: a single good flowing along one trade
  // path. `effect` is the actual amount moved (units of the good per month)
  // - verified against a real save: summing `effect` over every trade
  // arriving at a market reproduces that market's own per-good
  // supplied.Trade figure exactly (e.g. iron into market #0: 4 trades'
  // effects sum to 2.22435 = the market's supplied.Trade for iron).
  function extractTradeFields(number, obj) {
    if (!obj || typeof obj !== "object") return null;
    if (typeof obj.which !== "string") return null;
    return {
      number,
      good: obj.which,
      amount: obj.effect,
      power: obj.power,
      happened: obj.happened === true || obj.happened === "yes" || obj.happened === "Yes",
      tradePath: obj.trade_path,
    };
  }

  // One subunit_manager.database entry, reduced to what the navy-size
  // metric needs. Subunit types are prefixed by branch ("n_cog" vs
  // "a_footmen" - checked across an early and a late-age real save, every
  // naval type carries the n_ prefix), and a subunit raised as a levy
  // carries a `levies={...}` block naming its source estates (every *_levy
  // army type has one; so do levied ships like n_fishing_boat/n_birlinn,
  // while built warships - cogs, galleys, carracks - never do).
  function extractNavalSubunit(obj) {
    if (!obj || typeof obj !== "object") return null;
    if (typeof obj.type !== "string" || !obj.type.startsWith("n_")) return null;
    if (typeof obj.owner !== "number") return null;
    return { owner: obj.owner, levy: obj.levies !== undefined };
  }

  // One subunit_manager.database entry, reduced to what the army-size
  // metric needs. Army types carry the a_ prefix (the naval convention
  // above, "n_"), and the SAME subunit_manager section also holds a large
  // number of entirely unrelated entries (estate privileges, religions,
  // diplomatic unions/leagues/coalitions...) that happen to carry their own
  // unrelated `type` field too - confirmed on a real save (subunit_manager
  // held ~70k entries total, of which only ~2k were real "a_" army subunits
  // and ~850 were "n_" naval ones) - so the prefix check is load-bearing,
  // not just documentation; a bare "doesn't start with n_" check would
  // wrongly sweep all of those non-military entries in too.
  //
  // Three categories, confirmed mutually exclusive on a real save (zero
  // subunits ever carried both a `mercenary` and a `levies` field):
  // "mercenary" (a company hired from the mercenary pool), "levy" (a feudal/
  // tribal levy raised from estates, same `levies={...}` signal the naval
  // extractor uses), "regular" (a professional built regiment - neither of
  // the above).
  //
  // Real bug found deriving this: a mercenary subunit's `owner` field is
  // ALWAYS the constant sentinel 2 (confirmed identical across every
  // mercenary company regardless of which country actually employs them) -
  // `controller` is the real employer. Every category is counted by
  // `controller`, not just mercenaries: a small fraction (~0.5% on the same
  // real save) of ordinary levy/regular subunits also show a genuine
  // owner/controller split (temporarily foreign-controlled troops), and
  // "who currently fields this unit" is the more meaningful army-size
  // signal regardless of category.
  function extractArmySubunit(obj) {
    if (!obj || typeof obj !== "object") return null;
    if (typeof obj.type !== "string" || !obj.type.startsWith("a_")) return null;
    if (typeof obj.controller !== "number") return null;
    const category = obj.mercenary !== undefined ? "mercenary" : obj.levies !== undefined ? "levy" : "regular";
    // `strength` is this regiment's CURRENT troop count, in the same
    // "thousands" unit the rest of this app uses for population/manpower
    // (strength 0.40 = 400 men) - NOT a 0-1 fill fraction. Proven against a
    // real save: a Byzantine cataphract regiment at strength 0.40 shows as
    // exactly 400 men in-game, an archer at 0.50 as 500; and across 2003
    // regiments strength*1000 never exceeds that unit type's own max
    // capacity, landing exactly at it for full ones. js/app.js sums these
    // straight into the Military tab's "(k)" troop-headcount columns - no
    // unit-size table or game-install files needed.
    //
    // An ABSENT strength field means an unraised levy (0 current troops),
    // not a full regiment: confirmed on a real save that all 179 of 1939
    // strength-less subunits were levies (zero were built regulars, which
    // always carry an explicit strength), each an allocated-but-not-mustered
    // levy - it has its `levies={...}` pop list but no `experience` and no
    // strength because nothing has gathered yet. So it contributes 0 to the
    // current-troop sum. (An earlier version defaulted this to 1 under a
    // wrong "full regiments omit strength" assumption, which would have
    // added a phantom 1000 men per unraised levy.)
    return { controller: obj.controller, category, type: obj.type, strength: typeof obj.strength === "number" ? obj.strength : 0 };
  }

  function attachLocationAssets(result) {
    if (!result.locationAssets || !result.locationAssets.length) return;
    const locByNumber = new Map(result.locations.map((l) => [l.number, l]));
    for (const asset of result.locationAssets) {
      if (asset.building && typeof asset.location === "number") {
        const loc = locByNumber.get(asset.location);
        if (!loc) continue;
        if (!loc.buildingCounts) loc.buildingCounts = {};
        loc.buildingCounts[asset.building] = (loc.buildingCounts[asset.building] || 0) + 1;
        loc.buildingTotal = (loc.buildingTotal || 0) + 1;
      }
    }
  }

  function attachLocationBuildings(result) {
    if (!result.buildings || !result.buildings.length) return;
    const locByNumber = new Map(result.locations.map((l) => [l.number, l]));
    for (const building of result.buildings) {
      if (!building.type || typeof building.location !== "number") continue;
      const loc = locByNumber.get(building.location);
      if (!loc) continue;
      if (!loc.buildings) loc.buildings = [];
      if (!loc.buildingCounts) loc.buildingCounts = {};
      loc.buildings.push(building);
      loc.buildingCounts[building.type] = (loc.buildingCounts[building.type] || 0) + 1;
      loc.buildingTotal = (loc.buildingTotal || 0) + 1;
      loc.buildingLevelTotal = (loc.buildingLevelTotal || 0) + (typeof building.level === "number" ? building.level : 0);
    }
    for (const loc of locByNumber.values()) {
      if (Array.isArray(loc.buildings)) {
        loc.buildings.sort((a, b) => String(a.type || "").localeCompare(String(b.type || "")) || (a.number || 0) - (b.number || 0));
      }
    }
  }

  // Parses the "locations={ locations={...} }" section. `scanner` must be
  // positioned right after the opening '{' of the outer locations block.
  function parseLocationsSection(scanner, onLocation) {
    while (true) {
      scanner.skipWs();
      if (scanner.text[scanner.pos] === "}") {
        scanner.pos++;
        break;
      }
      if (scanner.eof()) break;
      const key = scanner.readScalarToken().raw;
      scanner.consumeIfPresent("=");

      if (key === "locations") {
        scanner.skipWs();
        if (scanner.text[scanner.pos] === "{") {
          scanner.pos++;
          while (true) {
            scanner.skipWs();
            if (scanner.text[scanner.pos] === "}") {
              scanner.pos++;
              break;
            }
            if (scanner.eof()) break;
            const numTok = scanner.readScalarToken();
            scanner.consumeIfPresent("=");
            const locObj = scanner.parseValue();
            if (locObj && typeof locObj === "object") {
              const number = parseInt(numTok.raw, 10);
              onLocation(extractLocationFields(number, locObj));
            }
          }
        } else {
          scanner.skipValue();
        }
      } else {
        scanner.skipValue();
      }
    }
  }

  // Extracts a subject/overlord relationship from one "dependency" entry:
  // { first=<overlord number> second=<subject number> named_targets={
  //   { flag=subject_type target={ type=subject_type object=vassal } } } }
  // "object" is the subject type (vassal, tributary, dominion, fiefdom, ...).
  function extractDependencyFields(obj) {
    const targets = Array.isArray(obj.named_targets) ? obj.named_targets : obj.named_targets ? [obj.named_targets] : [];
    const subjectTypeEntry = targets.find((t) => t && t.flag === "subject_type");
    const subjectType = subjectTypeEntry && subjectTypeEntry.target ? subjectTypeEntry.target.object : undefined;
    return { overlord: obj.first, subject: obj.second, subjectType };
  }

  // Extracts an enforced war-reparations obligation from one
  // "war_reparations" entry: { first=<payer number> second=<receiver number>
  // start_date=... expiration_date=... }. Direction confirmed against a real
  // save's already-independently-validated war outcome (see
  // test/debug-war-reparations.js and eu5-fixed-ids.js's comment) - "first"
  // is the LOSER who must pay, "second" is the WINNER who collects. A
  // reparations obligation typically lasts 10 in-game years, far longer than
  // war_manager keeps a concluded war's own record around, making this a
  // much more durable win/loss signal than land/gold deltas.
  function extractWarReparationsFields(obj) {
    return { payer: obj.first, receiver: obj.second, startDate: obj.start_date, expirationDate: obj.expiration_date };
  }

  // Parses "diplomacy_manager={ 0={...} 1={...} ... dependency={...}
  // war_reparations={...} ... }" - a large section keyed mostly by country
  // number (per-pair trust/rivalry data we don't need), with subject/overlord
  // and enforced-reparations relationships appearing as repeated entries
  // mixed in among them. Skips everything else.
  function parseDiplomacyManagerSection(scanner, onDependency, onWarReparations) {
    while (true) {
      scanner.skipWs();
      if (scanner.text[scanner.pos] === "}") {
        scanner.pos++;
        break;
      }
      if (scanner.eof()) break;
      const key = scanner.readScalarToken().raw;
      scanner.consumeIfPresent("=");
      if (key === "dependency") {
        const obj = scanner.parseValue();
        if (obj && typeof obj === "object") {
          const dep = extractDependencyFields(obj);
          if (typeof dep.overlord === "number" && typeof dep.subject === "number") onDependency(dep);
        }
      } else if (key === "war_reparations") {
        const obj = scanner.parseValue();
        if (obj && typeof obj === "object") {
          const rep = extractWarReparationsFields(obj);
          if (typeof rep.payer === "number" && typeof rep.receiver === "number") onWarReparations(rep);
        }
      } else {
        scanner.skipValue();
      }
    }
  }

  function parseEstateManagerSection(scanner, onAsset, onEstateIncome, onEstateMembership) {
    while (true) {
      scanner.skipWs();
      if (scanner.text[scanner.pos] === "}") {
        scanner.pos++;
        break;
      }
      if (scanner.eof()) break;
      const key = scanner.readScalarToken().raw;
      scanner.consumeIfPresent("=");
      if (key === "database") {
        scanner.skipWs();
        if (scanner.text[scanner.pos] === "{") {
          scanner.pos++;
          while (true) {
            scanner.skipWs();
            if (scanner.text[scanner.pos] === "}") {
              scanner.pos++;
              break;
            }
            if (scanner.eof()) break;
            const numTok = scanner.readScalarToken();
            scanner.consumeIfPresent("=");
            const assetObj = scanner.parseValue();
            const asset = extractEstateAssetFields(parseInt(numTok.raw, 10), assetObj);
            if (
              asset &&
              onEstateMembership &&
              asset.existence === true &&
              typeof asset.country === "number" &&
              typeof asset.estateType === "string"
            ) {
              onEstateMembership({ country: asset.country, estateType: asset.estateType });
            }
            // Road assets are deliberately dropped here rather than kept
            // and just hidden in the UI - the user confirmed the map's
            // "Roads" panel isn't reliable/useful enough to be worth the
            // parse cost, so entries are skipped at the source instead of
            // being extracted and then discarded downstream.
            if (asset && (asset.building || typeof asset.rgo === "number")) onAsset(asset);
            // The OTHER shape this same database mixes in - a country's
            // per-estate-type income summary (see extractEstateAssetFields'
            // comment) - has neither `location` nor `building`/`rgo`, so it
            // never hits the branch above; call the separate callback for
            // it instead of silently dropping it like a road asset would be.
            if (asset && onEstateIncome && typeof asset.country === "number" && (typeof asset.tradeIncome === "number" || typeof asset.paidTaxes === "number"))
              onEstateIncome(asset);
          }
        } else {
          scanner.skipValue();
        }
      } else {
        scanner.skipValue();
      }
    }
  }

  function parseBuildingManagerSection(scanner, onBuilding) {
    while (true) {
      scanner.skipWs();
      if (scanner.text[scanner.pos] === "}") {
        scanner.pos++;
        break;
      }
      if (scanner.eof()) break;
      const key = scanner.readScalarToken().raw;
      scanner.consumeIfPresent("=");
      if (key === "database") {
        scanner.skipWs();
        if (scanner.text[scanner.pos] === "{") {
          scanner.pos++;
          while (true) {
            scanner.skipWs();
            if (scanner.text[scanner.pos] === "}") {
              scanner.pos++;
              break;
            }
            if (scanner.eof()) break;
            const numTok = scanner.readScalarToken();
            scanner.consumeIfPresent("=");
            const buildingObj = scanner.parseValue();
            const building = extractBuildingFields(parseInt(numTok.raw, 10), buildingObj);
            if (building && building.type && typeof building.location === "number") onBuilding(building);
          }
        } else {
          scanner.skipValue();
        }
      } else {
        scanner.skipValue();
      }
    }
  }

  function parseNamedDatabaseSection(scanner, onEntry) {
    while (true) {
      scanner.skipWs();
      if (scanner.text[scanner.pos] === "}") {
        scanner.pos++;
        break;
      }
      if (scanner.eof()) break;
      const key = scanner.readScalarToken().raw;
      scanner.consumeIfPresent("=");
      if (key === "database") {
        scanner.skipWs();
        if (scanner.text[scanner.pos] === "{") {
          scanner.pos++;
          while (true) {
            scanner.skipWs();
            if (scanner.text[scanner.pos] === "}") {
              scanner.pos++;
              break;
            }
            if (scanner.eof()) break;
            const numTok = scanner.readScalarToken();
            scanner.consumeIfPresent("=");
            const obj = scanner.parseValue();
            const entry = extractNamedDefinitionFields(parseInt(numTok.raw, 10), obj);
            if (entry) onEntry(entry);
          }
        } else {
          scanner.skipValue();
        }
      } else {
        scanner.skipValue();
      }
    }
  }

  function parseMarketManagerSection(scanner, onMarket) {
    while (true) {
      scanner.skipWs();
      if (scanner.text[scanner.pos] === "}") {
        scanner.pos++;
        break;
      }
      if (scanner.eof()) break;
      const key = scanner.readScalarToken().raw;
      scanner.consumeIfPresent("=");
      if (key === "database") {
        scanner.skipWs();
        if (scanner.text[scanner.pos] === "{") {
          scanner.pos++;
          while (true) {
            scanner.skipWs();
            if (scanner.text[scanner.pos] === "}") {
              scanner.pos++;
              break;
            }
            if (scanner.eof()) break;
            const numTok = scanner.readScalarToken();
            scanner.consumeIfPresent("=");
            const obj = scanner.parseValue();
            const entry = extractMarketFields(parseInt(numTok.raw, 10), obj);
            if (entry) onMarket(entry);
          }
        } else {
          scanner.skipValue();
        }
      } else {
        scanner.skipValue();
      }
    }
  }

  // Generic "<section>={ database={ <n>={...} ... } }" walker for sections
  // whose entries need no per-section quirk handling - each database entry
  // is fully parsed and handed to onEntry(number, obj), everything else in
  // the section is skipped. Used by the trade/subunit sections below;
  // the older sections (markets, buildings, ...) predate this helper and
  // keep their own structurally-identical copies.
  function parsePlainDatabaseSection(scanner, onEntry) {
    while (true) {
      scanner.skipWs();
      if (scanner.text[scanner.pos] === "}") {
        scanner.pos++;
        break;
      }
      if (scanner.eof()) break;
      const key = scanner.readScalarToken().raw;
      scanner.consumeIfPresent("=");
      if (key === "database") {
        scanner.skipWs();
        if (scanner.text[scanner.pos] === "{") {
          scanner.pos++;
          while (true) {
            scanner.skipWs();
            if (scanner.text[scanner.pos] === "}") {
              scanner.pos++;
              break;
            }
            if (scanner.eof()) break;
            const numTok = scanner.readScalarToken();
            scanner.consumeIfPresent("=");
            const obj = scanner.parseValue();
            onEntry(parseInt(numTok.raw, 10), obj);
          }
        } else {
          scanner.skipValue();
        }
      } else {
        scanner.skipValue();
      }
    }
  }

  // Parses the "countries={ tags={...} database={...} }" section. `scanner`
  // must be positioned right after the opening '{' of the countries block.
  function parseCountriesSection(scanner, onCountry, includeModifierState) {
    const tags = {};
    while (true) {
      scanner.skipWs();
      if (scanner.text[scanner.pos] === "}") {
        scanner.pos++;
        break;
      }
      if (scanner.eof()) break;
      const key = scanner.readScalarToken().raw;
      scanner.consumeIfPresent("=");

      if (key === "tags") {
        Object.assign(tags, scanner.parseValue());
      } else if (key === "database") {
        scanner.skipWs();
        if (scanner.text[scanner.pos] === "{") {
          scanner.pos++;
          while (true) {
            scanner.skipWs();
            if (scanner.text[scanner.pos] === "}") {
              scanner.pos++;
              break;
            }
            if (scanner.eof()) break;
            const numTok = scanner.readScalarToken();
            scanner.consumeIfPresent("=");
            const countryObj = scanner.parseValue();
            if (countryObj && typeof countryObj === "object") {
              const number = parseInt(numTok.raw, 10);
              onCountry(extractCountryFields(number, countryObj, includeModifierState));
            }
          }
        } else {
          scanner.skipValue();
        }
      } else {
        scanner.skipValue();
      }
    }
    return tags;
  }

  // Extracts the handful of fields the Llama score engine (js/llama-score.js)
  // needs from one war_manager.database entry. War blocks also contain a
  // deep combat log ("battle", repeated per engagement) and localization
  // templates ("war_name") we have no use for - discarded along with
  // everything else not listed below.
  //
  // No clean "who won" field survives a concluded war (EU5 clears
  // attacker_score/defender_score/war_goal_held once previous=yes is set,
  // and participant status/left.reason is identical - "Left"/"WarEnded" -
  // for winners and losers alike). The "locations" occupation snapshot DOES
  // survive conclusion though, so we summarize it into attacker/defender
  // location counts here for the score engine's win/loss heuristic to use,
  // rather than retaining the raw (sometimes hundreds-of-entries) map.
  function extractWarFields(number, obj) {
    if (!obj || typeof obj !== "object") return null;
    const allRaw = obj.all;
    const participantsRaw = Array.isArray(allRaw) ? allRaw : allRaw && typeof allRaw === "object" ? [allRaw] : [];
    const originalDefendersRaw = obj.original_defenders;
    const originalDefenders = Array.isArray(originalDefendersRaw)
      ? originalDefendersRaw
      : typeof originalDefendersRaw === "number"
      ? [originalDefendersRaw]
      : [];

    function participantHistory(p) {
      if (Array.isArray(p.history)) return p.history[p.history.length - 1] || {};
      if (p.history && typeof p.history === "object") return p.history;
      // At least one observed melted text export (game version 1.3.10)
      // names this field "all_history" instead of "history" - same shape
      // either way. Binary saves are unaffected (confirmed against a real
      // 1.3.10 binary autosave - resolves via fixed token 0x3db9 below
      // regardless of which string the text melter used), so this is a
      // defensive fallback for the text-format parser only.
      if (Array.isArray(p.all_history)) return p.all_history[p.all_history.length - 1] || {};
      if (p.all_history && typeof p.all_history === "object") return p.all_history;
      // Binary saves encode this field as fixed token 0x3db9 in observed
      // EU5 builds. The token table does not name it yet, but the nested
      // shape is identical to melted `history={ request={...} joined={...} }`.
      const raw = p["#3db9"];
      if (Array.isArray(raw)) return raw[raw.length - 1] || {};
      return raw && typeof raw === "object" ? raw : {};
    }

    const sideByCountry = new Map();
    if (typeof obj.original_attacker === "number") sideByCountry.set(obj.original_attacker, "Attacker");
    for (const country of originalDefenders) sideByCountry.set(country, "Defender");
    const participants = [];
    for (const p of participantsRaw) {
      if (!p || typeof p !== "object") continue;
      const history = participantHistory(p);
      const request = history.request || {};
      const joined = history.joined || {};
      const left = history.left;
      const score = joined.score || {};
      const country = p.country;
      if (typeof country === "number" && (request.side === "Attacker" || request.side === "Defender")) {
        sideByCountry.set(country, request.side);
      }
      participants.push({
        country,
        side: request.side, // "Attacker" | "Defender"
        reason: request.reason, // Instigator | Target | Scripted | CanCall...
        calledAlly: typeof request.called_ally === "number" ? request.called_ally : null,
        // "revolter=Yes" (capital Y) is a distinct token from the "yes"
        // boolean literal coerceScalar() lowercases - it comes through as
        // the raw string "Yes", not true. Check both spellings.
        revolter: request.revolter === true || request.revolter === "Yes",
        joinDate: typeof joined.date === "string" ? joined.date : null,
        leaveDate: left && typeof left.date === "string" ? left.date : null,
        combat: typeof score.Combat === "number" ? score.Combat : 0,
        siege: typeof score.Siege === "number" ? score.Siege : 0,
        status: p.status, // Active | Left
        // Per-participant casualties, same shape/units as the war-wide
        // attacker_losses/defender_losses below (sumLosses is shared) -
        // nested one level deeper here, under this participant's own
        // history.joined.losses, not the war-wide totals. Lets the scoring
        // engine tell "actually fought" apart from "joined then left without
        // a single battle" per-country, which the war-wide aggregate can't
        // do (js/llama-score.js's hasFoughtLosses()).
        losses: sumLosses(joined.losses),
      });
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const p of participants) {
        if (typeof p.country !== "number" || sideByCountry.has(p.country)) continue;
        if (typeof p.calledAlly === "number" && sideByCountry.has(p.calledAlly)) {
          sideByCountry.set(p.country, sideByCountry.get(p.calledAlly));
          changed = true;
        }
      }
    }
    for (const p of participants) {
      if (p.side !== "Attacker" && p.side !== "Defender") p.side = sideByCountry.get(p.country) || p.side;
    }

    // NOTE: this war entry's own `locations` map is who *owns* each of these
    // locations, not who currently *controls* them - ownership doesn't
    // change until a peace treaty transfers it, so for an ongoing war this
    // is frozen at (essentially) pre-war values the entire time, not a live
    // occupation signal at all. Confirmed on real data: three real multi-
    // year wars each showed byte-identical attacker/defender location
    // counts on *every single snapshot* from war-start to war-disappeared -
    // impossible for genuine battlefield occupation to hold steady that
    // long, but exactly what you'd expect from ownership that simply hasn't
    // transferred yet. Cross-checked directly against a real save's
    // `locations.locations[].owner` vs `.controller`: this war's own map
    // matched `owner` on 145/145 sampled locations and `controller` on only
    // 143/145 - the discrepancy is exactly the (small) set of locations
    // someone has actually seized so far.
    //
    // Real live occupation requires `locations.locations[].controller`,
    // which isn't available here (this function only sees the war entry
    // itself) - so this computes the OWNERSHIP-based split for backward
    // compatibility/fallback, and separately retains locationIds +
    // sideByCountry so parseSave/parseCompressedSave's post-pass
    // (reconcileWarOccupation, below) can recompute this using the real
    // `locations.locations[].controller` once the whole save has been
    // walked - but only when the caller actually parsed locations
    // (includeLocations: true); otherwise this ownership-based value is
    // all that's available, same as before.
    let attackerLocations = 0;
    let defenderLocations = 0;
    let otherLocations = 0;
    let totalLocations = 0;
    const locationIds = [];
    if (obj.locations && typeof obj.locations === "object" && !Array.isArray(obj.locations)) {
      for (const [locIdRaw, ownerRaw] of Object.entries(obj.locations)) {
        totalLocations++;
        const locId = Number(locIdRaw);
        if (Number.isFinite(locId)) locationIds.push(locId);
        const side = typeof ownerRaw === "number" ? sideByCountry.get(ownerRaw) : undefined;
        if (side === "Attacker") attackerLocations++;
        else if (side === "Defender") defenderLocations++;
        else otherLocations++;
      }
    }
    const sideByCountryMap = {};
    for (const [country, side] of sideByCountry) sideByCountryMap[country] = side;

    // War-wide casualty totals (`attacker_losses`/`defender_losses`), unlike
    // `attacker_score`/`defender_score`, survive war conclusion - confirmed
    // on a real concluded war entry (`previous=yes`), which still had both
    // fully populated. Each is `{ losses: { <unit_type>: { Battle, Attrition,
    // Capture } } }`, summed here into one total per cause plus a grand
    // total per side - a useful corroborating signal for the win/loss
    // heuristic (js/llama-score.js) precisely because it doesn't get wiped
    // the way the war-level score fields do.
    // Attrition is deliberately not summed/stored here (nor is a "total") -
    // confirmed nothing in the codebase ever reads either (battleLossSignal
    // and hasFoughtLosses in js/llama-score.js both only look at
    // battle+capture, the actual combat-inflicted signal; attrition accrues
    // to armies just standing in a warzone, not fighting). Dropping both
    // keeps the ledger this gets persisted into smaller for zero functional
    // loss - see the "how big does the ledger get" discussion.
    function sumLosses(lossesObj) {
      const totals = { battle: 0, capture: 0 };
      const byUnit = lossesObj && lossesObj.losses;
      if (byUnit && typeof byUnit === "object") {
        for (const unit of Object.values(byUnit)) {
          if (!unit || typeof unit !== "object") continue;
          if (typeof unit.Battle === "number") totals.battle += unit.Battle;
          if (typeof unit.Capture === "number") totals.capture += unit.Capture;
        }
      }
      return totals;
    }

    return {
      number,
      participants,
      revolt: obj.revolt === true,
      originalAttacker: typeof obj.original_attacker === "number" ? obj.original_attacker : null,
      originalDefenders,
      startDate: typeof obj.start_date === "string" ? obj.start_date : null,
      endDate: typeof obj.end_date === "string" ? obj.end_date : null,
      concluded: obj.previous === true,
      warGoalHeld: typeof obj.war_goal_held === "number" ? obj.war_goal_held : null,
      // The game's own internal war-goal label (e.g. "INDEPENDENCE_WAR_NAME",
      // "CIVIL_WAR_NAME", "NORMAL_WAR_NAME") - see reparationsSignal-adjacent
      // independence handling in economicOutcomeSignal, which uses this to
      // detect an independence war directly instead of inferring it from a
      // before/after vassal-status comparison.
      warName: obj.war_name && typeof obj.war_name === "object" && typeof obj.war_name.name === "string" ? obj.war_name.name : null,
      attackerScore: typeof obj.attacker_score === "number" ? obj.attacker_score : null,
      defenderScore: typeof obj.defender_score === "number" ? obj.defender_score : null,
      occupation: { attackerLocations, defenderLocations, otherLocations, totalLocations },
      attackerLosses: sumLosses(obj.attacker_losses),
      defenderLosses: sumLosses(obj.defender_losses),
      // Also present but not yet wired up: attacker_siege_pop_losses/
      // defender_siege_pop_losses and attacker_levy_pop_losses/
      // defender_levy_pop_losses (population lost to sieges/levies per
      // side) - seen in melted text on a real war, held back here rather
      // than added asymmetrically because the binary fixed ID for the
      // defender-side counterpart couldn't be cross-validated yet (see
      // js/eu5-fixed-ids.js's note). attacker_losses/defender_losses above
      // are the ones actually used for scoring; these are a possible
      // future refinement, not a current gap in the win/loss heuristic.
      stalledYears: typeof obj.stalled_years === "number" ? obj.stalled_years : null,
      // Internal - consumed by reconcileWarOccupation() below, then deleted
      // from the final result. Not meaningful to any other caller.
      locationIds,
      sideByCountryMap,
    };
  }

  // Recomputes each war's `occupation` from real, live location CONTROLLER
  // data (locations.locations[].controller) instead of the war entry's own
  // (frozen, ownership-based - see extractWarFields' comment above)
  // locations map, then discards the temporary fields extractWarFields
  // stashed for this purpose. Only does anything when the caller actually
  // parsed locations (`includeLocations: true` - result.locations
  // non-empty); otherwise every war's `occupation` is left exactly as
  // extractWarFields computed it (the ownership-based fallback), same
  // behavior as before this existed. Shared by both parsers - called once
  // at the end of each one's top-level walk, after result.wars AND
  // result.locations are both fully populated.
  //
  // attackerLocations/defenderLocations count ONLY genuine cross-occupation
  // (controller on one side, but OWNER on the other) - i.e. land actually
  // seized from the enemy, not each side's own untouched home territory.
  // Confirmed this distinction matters on real data: a war's roster
  // previously reported "attackerLocations: 109, defenderLocations: 279" as
  // if that meant something about who was winning, but a full owner-vs-
  // controller breakdown showed defenderLocations was 279/279 the
  // defender's OWN home provinces (zero enemy soil actually held) and
  // attackerLocations was only 56/109 real enemy territory (the other 53
  // was the attacker's own home turf sitting in the same roster) - the old
  // numbers were dominated by whichever side simply has the bigger home
  // empire, not by who was actually gaining ground. `otherLocations` now
  // absorbs both untouched home turf on either side AND any third-party-
  // owned land in the roster (a vassal, etc.) - the invariant
  // `totalLocations = attackerLocations + defenderLocations + otherLocations`
  // still holds, just with a more meaningful split.
  function reconcileWarOccupation(result) {
    const wars = result.wars || [];
    const hasLocations = result.locations && result.locations.length;
    const controllerByLocation = hasLocations ? new Map(result.locations.map((l) => [l.number, l.controller])) : null;
    const ownerByLocation = hasLocations ? new Map(result.locations.map((l) => [l.number, l.owner])) : null;
    for (const war of wars) {
      const locationIds = war.locationIds;
      const sideByCountryMap = war.sideByCountryMap;
      delete war.locationIds;
      delete war.sideByCountryMap;
      if (!controllerByLocation || !locationIds || !locationIds.length) continue;
      let attackerLocations = 0;
      let defenderLocations = 0;
      let otherLocations = 0;
      let totalLocations = 0;
      for (const locId of locationIds) {
        totalLocations++;
        const controller = controllerByLocation.get(locId);
        const owner = ownerByLocation.get(locId);
        const controllerSide = typeof controller === "number" ? sideByCountryMap[controller] : undefined;
        const ownerSide = typeof owner === "number" ? sideByCountryMap[owner] : undefined;
        if (controllerSide === "Attacker" && ownerSide === "Defender") attackerLocations++;
        else if (controllerSide === "Defender" && ownerSide === "Attacker") defenderLocations++;
        else otherLocations++;
      }
      war.occupation = { attackerLocations, defenderLocations, otherLocations, totalLocations };
    }
  }

  // Parses "war_manager={ names={...} database={...} }" - mirrors
  // parseEstateManagerSection/parseMarketManagerSection's shape. "names"
  // (naming templates) is skipped; each database entry is fully parsed
  // then immediately reduced via extractWarFields and discarded, same
  // per-entry-then-discard treatment every other selective section uses.
  function parseWarManagerSection(scanner, onWar) {
    while (true) {
      scanner.skipWs();
      if (scanner.text[scanner.pos] === "}") {
        scanner.pos++;
        break;
      }
      if (scanner.eof()) break;
      const key = scanner.readScalarToken().raw;
      scanner.consumeIfPresent("=");
      if (key === "database") {
        scanner.skipWs();
        if (scanner.text[scanner.pos] === "{") {
          scanner.pos++;
          while (true) {
            scanner.skipWs();
            if (scanner.text[scanner.pos] === "}") {
              scanner.pos++;
              break;
            }
            if (scanner.eof()) break;
            const numTok = scanner.readScalarToken();
            scanner.consumeIfPresent("=");
            const warObj = scanner.parseValue();
            const war = extractWarFields(parseInt(numTok.raw, 10), warObj);
            if (war) onWar(war);
          }
        } else {
          scanner.skipValue();
        }
      } else {
        scanner.skipValue();
      }
    }
  }

  function extractPlayer(obj) {
    return {
      name: obj.name,
      id: obj.id,
      countryNumber: obj.country,
      proficiency: obj.player_proficiency,
      preferredMapMode: obj.preferred_map_mode,
    };
  }

  // situation_manager tracks ~20 scripted historical events (black_death,
  // hundred_years_war, sengoku, ...) by name; only black_death is read here.
  // Small (a few KB even in a large save) - safe to fully parse rather than
  // needing the selective per-entry treatment countries/locations get.
  function extractBlackDeath(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj))
      return { status: null, start: null, end: null, identity: null, deathsByCountry: null };
    // `variables.data` holds a handful of {flag, data} tags this scripted
    // event tracks - "original_outbreak" points (via a {type=disease_outbreak,
    // identity=N} reference) at this specific instance's entry in
    // disease_outbreak_manager.data. Needed to sum only THIS outbreak's
    // deaths there, not every bubonic-plague wave the campaign ever had.
    let identity = null;
    const variables = obj.variables;
    const dataEntries = variables && variables.data ? (Array.isArray(variables.data) ? variables.data : [variables.data]) : [];
    for (const entry of dataEntries) {
      if (entry && entry.flag === "original_outbreak" && entry.data && entry.data.type === "disease_outbreak" && typeof entry.data.identity === "number") {
        identity = entry.data.identity;
        break;
      }
    }
    return {
      status: typeof obj.status === "string" ? obj.status : null,
      start: typeof obj.start === "string" ? obj.start : null,
      end: typeof obj.end === "string" ? obj.end : null,
      identity,
      deathsByCountry: null,
    };
  }

  // disease_outbreak_manager={ database={...outbreak origin metadata, not
  // needed - situation_manager.black_death already gives start/end/identity}
  // data={ {type=<disease type> locations={...per-location resistance/
  // immunity simulation state, can be 100k+ lines for a disease that's
  // touched most of the map - the reason this section isn't parsed
  // generically} countries={ {county=<country number> deaths={
  // {disease_outbreak=<outbreak identity> deaths=<float>} ...}} ...}
  // date=...} ...} }
  //
  // The per-country Black Death toll needs to come from here, not a
  // population time-series diff (start-of-event vs end-of-event population,
  // the Statistics tab's old approach) - that diff is polluted by any land
  // gained or lost during the outbreak window (conquest, colonization, war
  // losses), which has nothing to do with actual plague deaths. This field
  // is the game's own per-country death tally, attributed to whichever
  // country owned a location at the moment of each death - immune to that
  // pollution, and the same number the in-game "disease breakdown" UI reads.
  // Only entries whose disease_outbreak matches `targetIdentity` are kept,
  // since a country can have suffered multiple separate bubonic-plague waves
  // across a long campaign and we only want the tracked Black Death event.
  function parseDiseaseOutbreakManagerSection(scanner, targetIdentity) {
    const deathsByCountry = {};

    function parseDeathEntry() {
      let diseaseOutbreak = null;
      let amount = null;
      while (true) {
        scanner.skipWs();
        if (scanner.text[scanner.pos] === "}") {
          scanner.pos++;
          break;
        }
        if (scanner.eof()) break;
        const k = scanner.readScalarToken().raw;
        scanner.consumeIfPresent("=");
        if (k === "disease_outbreak") diseaseOutbreak = parseInt(scanner.readScalarToken().raw, 10);
        else if (k === "deaths") amount = parseFloat(scanner.readScalarToken().raw);
        else scanner.skipValue();
      }
      return { diseaseOutbreak, amount };
    }

    function parseCountryEntry() {
      let county = null;
      let total = 0;
      while (true) {
        scanner.skipWs();
        if (scanner.text[scanner.pos] === "}") {
          scanner.pos++;
          break;
        }
        if (scanner.eof()) break;
        const k = scanner.readScalarToken().raw;
        scanner.consumeIfPresent("=");
        if (k === "county") {
          county = parseInt(scanner.readScalarToken().raw, 10);
        } else if (k === "deaths") {
          scanner.skipWs();
          if (scanner.text[scanner.pos] === "{") {
            scanner.pos++;
            while (true) {
              scanner.skipWs();
              if (scanner.text[scanner.pos] === "}") {
                scanner.pos++;
                break;
              }
              if (scanner.eof()) break;
              if (scanner.text[scanner.pos] === "{") {
                scanner.pos++;
                const d = parseDeathEntry();
                if (d.diseaseOutbreak === targetIdentity && typeof d.amount === "number") total += d.amount;
              } else {
                scanner.skipValue();
              }
            }
          } else {
            scanner.skipValue();
          }
        } else {
          scanner.skipValue();
        }
      }
      if (county !== null) deathsByCountry[county] = (deathsByCountry[county] || 0) + total;
    }

    function parseTypeEntry() {
      while (true) {
        scanner.skipWs();
        if (scanner.text[scanner.pos] === "}") {
          scanner.pos++;
          break;
        }
        if (scanner.eof()) break;
        const k = scanner.readScalarToken().raw;
        scanner.consumeIfPresent("=");
        if (k === "countries") {
          scanner.skipWs();
          if (scanner.text[scanner.pos] === "{") {
            scanner.pos++;
            while (true) {
              scanner.skipWs();
              if (scanner.text[scanner.pos] === "}") {
                scanner.pos++;
                break;
              }
              if (scanner.eof()) break;
              if (scanner.text[scanner.pos] === "{") {
                scanner.pos++;
                parseCountryEntry();
              } else {
                scanner.skipValue();
              }
            }
          } else {
            scanner.skipValue();
          }
        } else {
          // "locations" (huge) / "type" / "date" / "current" - none needed.
          scanner.skipValue();
        }
      }
    }

    while (true) {
      scanner.skipWs();
      if (scanner.text[scanner.pos] === "}") {
        scanner.pos++;
        break;
      }
      if (scanner.eof()) break;
      const key = scanner.readScalarToken().raw;
      scanner.consumeIfPresent("=");
      if (key === "data") {
        scanner.skipWs();
        if (scanner.text[scanner.pos] === "{") {
          scanner.pos++;
          while (true) {
            scanner.skipWs();
            if (scanner.text[scanner.pos] === "}") {
              scanner.pos++;
              break;
            }
            if (scanner.eof()) break;
            if (scanner.text[scanner.pos] === "{") {
              scanner.pos++;
              parseTypeEntry();
            } else {
              scanner.skipValue();
            }
          }
        } else {
          scanner.skipValue();
        }
      } else {
        scanner.skipValue();
      }
    }

    return deathsByCountry;
  }

  // provinces={ database={ 0={ capital=1 province_definition="uppland_province"
  // owner=3 food={...} last_month_produced={...} variables={...} } ... } }
  //
  // A COARSER grouping than locations.locations (matches definitions.txt's
  // "_province" level - several locations per province, see
  // tools/build-location-data.js's per-location `province` field). Its own
  // owner can be set even when an individual location within it has no
  // owner of its own - confirmed against a real save where three whole
  // provinces (verona/venice/vicenza_province) were fully SAR-owned while
  // every individual location inside them had a blank owner field. The
  // in-game client and third-party tools read ownership at this level;
  // js/map.js's applyProvinceOwnerFallback uses this to fill in a
  // location's effective owner when its own field is blank, using
  // tools/build-location-data.js's per-location `province` name to look up
  // which entry here applies.
  //
  // Each entry also carries per-province economy simulation state (food,
  // trade, army, navy, last_month_produced, variables) - not huge like
  // disease_outbreak_manager's per-location resistance blob, so (like
  // war_manager.database) each entry is fully parsed then immediately
  // reduced to {definition, owner} and discarded, rather than needing a
  // field-by-field selective walk.
  function extractProvinceOwner(obj) {
    if (!obj || typeof obj !== "object") return null;
    const definition = typeof obj.province_definition === "string" ? obj.province_definition : null;
    const owner = typeof obj.owner === "number" ? obj.owner : null;
    if (!definition) return null;
    return { definition, owner };
  }

  function parseProvincesSection(scanner, onProvince) {
    while (true) {
      scanner.skipWs();
      if (scanner.text[scanner.pos] === "}") {
        scanner.pos++;
        break;
      }
      if (scanner.eof()) break;
      const key = scanner.readScalarToken().raw;
      scanner.consumeIfPresent("=");
      if (key === "database") {
        scanner.skipWs();
        if (scanner.text[scanner.pos] === "{") {
          scanner.pos++;
          while (true) {
            scanner.skipWs();
            if (scanner.text[scanner.pos] === "}") {
              scanner.pos++;
              break;
            }
            if (scanner.eof()) break;
            scanner.readScalarToken(); // entry number - not needed
            scanner.consumeIfPresent("=");
            const obj = scanner.parseValue();
            const p = extractProvinceOwner(obj);
            if (p) onProvince(p);
          }
        } else {
          scanner.skipValue();
        }
      } else {
        scanner.skipValue();
      }
    }
  }

  // A loan entry can be `=none` (a cleared/tombstoned loan - confirmed on
  // real data) instead of an object, and can carry a "lender" field too
  // (player-to-player loans, presumably) which isn't needed here - only
  // amount+borrower matter for the llama war-scoring debt-netting use case
  // (see economicOutcomeSignal's net-of-debt treasury signal).
  function extractLoanFields(obj) {
    if (!obj || typeof obj !== "object") return null;
    const borrower = typeof obj.borrower === "number" ? obj.borrower : null;
    const amount = typeof obj.amount === "number" ? obj.amount : null;
    if (borrower === null || amount === null) return null;
    return { borrower, amount };
  }

  function parseLoanManagerSection(scanner, onLoan) {
    while (true) {
      scanner.skipWs();
      if (scanner.text[scanner.pos] === "}") {
        scanner.pos++;
        break;
      }
      if (scanner.eof()) break;
      const key = scanner.readScalarToken().raw;
      scanner.consumeIfPresent("=");
      if (key === "database") {
        scanner.skipWs();
        if (scanner.text[scanner.pos] === "{") {
          scanner.pos++;
          while (true) {
            scanner.skipWs();
            if (scanner.text[scanner.pos] === "}") {
              scanner.pos++;
              break;
            }
            if (scanner.eof()) break;
            scanner.readScalarToken(); // entry number - not needed
            scanner.consumeIfPresent("=");
            const obj = scanner.parseValue();
            const loan = extractLoanFields(obj);
            if (loan) onLoan(loan);
          }
        } else {
          scanner.skipValue();
        }
      } else {
        scanner.skipValue();
      }
    }
  }

  // Top-level sections we fully or partially parse; everything else is
  // skipped without allocating.
  const BASE_TOP_LEVEL_KEYS = [
    "metadata",
    "countries",
    "played_country",
    "diplomacy_manager",
    "situation_manager",
    "disease_outbreak_manager",
    "loan_manager",
    "international_organization_manager",
    "character_db",
    "work_of_art_manager",
    // Always parsed (not gated behind includeLocations): the Metrics tab's
    // "Navy Size" column counts real ships from here, and the walk only
    // materializes naval subunits (a small fraction of the section).
    "subunit_manager",
  ];

  function parseSave(text, options) {
    options = options || {};
    const onProgress = options.onProgress || function () {};
    // locations.locations is ~4.5M lines in a large save - opt-in only, so
    // existing callers (validation, country-only stats) don't pay for a
    // section they don't use.
    const includeLocations = !!options.includeLocations;
    // war_manager.database entries carry a big per-battle combat log each -
    // opt-in for the same reason, independent of includeLocations (the
    // Llama score view needs wars but not the location map, and vice versa).
    const includeWars = !!options.includeWars;
    const includeModifierState = !!options.includeModifierState;
    const HANDLED_TOP_LEVEL_KEYS = new Set(
      BASE_TOP_LEVEL_KEYS.concat(
        includeLocations ? ["locations", "population", "estate_manager", "building_manager", "culture_manager", "religion_manager", "market_manager", "provinces", "trade_path_manager", "trade_manager"] : [],
        includeWars ? ["war_manager"] : []
      )
    );

    // The file starts with a magic header line (e.g. "SAV0200...\n") that
    // isn't part of the key=value grammar - skip past it before parsing.
    let startPos = 0;
    if (text.slice(0, 3) === "SAV") {
      const nl = text.indexOf("\n", 0);
      startPos = nl === -1 ? 0 : nl + 1;
    }

    const scanner = new Scanner(text, startPos, text.length);
    const result = {
      metadata: {},
      countries: [],
      countriesByNumber: new Map(),
      players: [],
      playerSessions: [],
      locations: [],
      dependencies: [],
      warReparations: [],
      locationAssets: [],
      estateTradeIncomes: [],
      activeEstateMemberships: [],
      estateManagerSeen: false,
      buildings: [],
      cultures: [],
      religions: [],
      internationalOrganizations: [],
      societalCharacters: [],
      societalWorksOfArt: [],
      markets: [],
      wars: [],
      blackDeath: { status: null, start: null, end: null, identity: null, deathsByCountry: null },
      provinceOwnerByDefinition: {},
      countryDebt: new Map(),
      tradePaths: [],
      trades: [],
      tradeRoutes: [],
      navalSubunits: [],
      armySubunits: [],
      popRecords: [],
      subunitManagerSeen: false,
    };

    let lastProgressPos = 0;
    const PROGRESS_STEP = Math.max(1, Math.floor(text.length / 200));

    while (!scanner.eof()) {
      scanner.skipWs();
      if (scanner.eof()) break;
      if (scanner.text[scanner.pos] === "}") {
        // Stray close brace at depth 0 shouldn't happen; guard against
        // infinite loops on malformed input.
        scanner.pos++;
        continue;
      }

      const keyTok = scanner.readScalarToken();
      const key = keyTok.raw;
      if (!key) {
        // Couldn't make progress (unexpected char) - bail rather than hang.
        break;
      }
      scanner.consumeIfPresent("=");

      if (!HANDLED_TOP_LEVEL_KEYS.has(key)) {
        scanner.skipValue();
      } else if (key === "metadata") {
        scanner.skipWs();
        if (scanner.text[scanner.pos] === "{") {
          scanner.pos++;
          result.metadata = scanner.parseBlockBody();
        } else {
          scanner.skipValue();
        }
      } else if (key === "countries") {
        scanner.skipWs();
        if (scanner.text[scanner.pos] === "{") {
          scanner.pos++;
          result.metadata.tags = parseCountriesSection(scanner, (country) => {
            result.countries.push(country);
            result.countriesByNumber.set(country.number, country);
          }, includeModifierState);
        } else {
          scanner.skipValue();
        }
      } else if (key === "played_country") {
        const obj = scanner.parseValue();
        if (obj && typeof obj === "object") {
          result.players.push(extractPlayer(obj));
        }
      } else if (key === "locations") {
        scanner.skipWs();
        if (scanner.text[scanner.pos] === "{") {
          scanner.pos++;
          parseLocationsSection(scanner, (location) => {
            result.locations.push(location);
          });
        } else {
          scanner.skipValue();
        }
      } else if (key === "population") {
        scanner.skipWs();
        if (scanner.text[scanner.pos] === "{") {
          scanner.pos++;
          parsePlainDatabaseSection(scanner, (number, obj) => {
            const pop = extractPopFields(number, obj);
            if (pop) result.popRecords.push(pop);
          });
        } else {
          scanner.skipValue();
        }
      } else if (key === "diplomacy_manager") {
        scanner.skipWs();
        if (scanner.text[scanner.pos] === "{") {
          scanner.pos++;
          parseDiplomacyManagerSection(
            scanner,
            (dep) => {
              result.dependencies.push(dep);
            },
            (rep) => {
              result.warReparations.push(rep);
            }
          );
        } else {
          scanner.skipValue();
        }
      } else if (key === "international_organization_manager") {
        if (!includeModifierState) {
          scanner.skipValue();
        } else {
          scanner.skipWs();
          if (scanner.text[scanner.pos] === "{") {
            scanner.pos++;
            parsePlainDatabaseSection(scanner, (number, obj) => {
              const organization = extractInternationalOrganizationFields(number, obj);
              if (organization) result.internationalOrganizations.push(organization);
            });
          } else {
            scanner.skipValue();
          }
        }
      } else if (key === "character_db" || key === "work_of_art_manager") {
        if (!includeModifierState) {
          scanner.skipValue();
        } else {
          scanner.skipWs();
          if (scanner.text[scanner.pos] === "{") {
            scanner.pos++;
            parsePlainDatabaseSection(scanner, (number, obj) => {
              const entry = key === "character_db"
                ? extractCharacterSocietalFields(number, obj)
                : extractWorkOfArtSocietalFields(number, obj);
              if (entry) (key === "character_db" ? result.societalCharacters : result.societalWorksOfArt).push(entry);
            });
          } else {
            scanner.skipValue();
          }
        }
      } else if (key === "situation_manager") {
        const obj = scanner.parseValue();
        if (obj && typeof obj === "object") {
          result.blackDeath = extractBlackDeath(obj.black_death);
        }
      } else if (key === "disease_outbreak_manager") {
        // Only walk this (potentially very large) section once we actually
        // know which outbreak identity to look for - situation_manager
        // always appears earlier in the file, so result.blackDeath.identity
        // is already set by the time we get here if the Black Death has
        // started this campaign. Otherwise skip it wholesale, same cost as
        // any other unhandled top-level key.
        if (typeof result.blackDeath.identity !== "number") {
          scanner.skipValue();
        } else {
          scanner.skipWs();
          if (scanner.text[scanner.pos] === "{") {
            scanner.pos++;
            result.blackDeath.deathsByCountry = parseDiseaseOutbreakManagerSection(scanner, result.blackDeath.identity);
          } else {
            scanner.skipValue();
          }
        }
      } else if (key === "estate_manager") {
        scanner.skipWs();
        if (scanner.text[scanner.pos] === "{") {
          scanner.pos++;
          result.estateManagerSeen = true;
          parseEstateManagerSection(
            scanner,
            (asset) => {
              result.locationAssets.push(asset);
            },
            (entry) => {
              result.estateTradeIncomes.push(entry);
            },
            (entry) => {
              result.activeEstateMemberships.push(entry);
            }
          );
        } else {
          scanner.skipValue();
        }
      } else if (key === "building_manager") {
        scanner.skipWs();
        if (scanner.text[scanner.pos] === "{") {
          scanner.pos++;
          parseBuildingManagerSection(scanner, (building) => {
            result.buildings.push(building);
          });
        } else {
          scanner.skipValue();
        }
      } else if (key === "culture_manager") {
        scanner.skipWs();
        if (scanner.text[scanner.pos] === "{") {
          scanner.pos++;
          parseNamedDatabaseSection(scanner, (entry) => result.cultures.push(entry));
        } else {
          scanner.skipValue();
        }
      } else if (key === "religion_manager") {
        scanner.skipWs();
        if (scanner.text[scanner.pos] === "{") {
          scanner.pos++;
          parseNamedDatabaseSection(scanner, (entry) => result.religions.push(entry));
        } else {
          scanner.skipValue();
        }
      } else if (key === "market_manager") {
        scanner.skipWs();
        if (scanner.text[scanner.pos] === "{") {
          scanner.pos++;
          parseMarketManagerSection(scanner, (entry) => result.markets.push(entry));
        } else {
          scanner.skipValue();
        }
      } else if (key === "provinces") {
        scanner.skipWs();
        if (scanner.text[scanner.pos] === "{") {
          scanner.pos++;
          parseProvincesSection(scanner, (p) => {
            result.provinceOwnerByDefinition[p.definition] = p.owner;
          });
        } else {
          scanner.skipValue();
        }
      } else if (key === "war_manager") {
        scanner.skipWs();
        if (scanner.text[scanner.pos] === "{") {
          scanner.pos++;
          parseWarManagerSection(scanner, (war) => result.wars.push(war));
        } else {
          scanner.skipValue();
        }
      } else if (key === "loan_manager") {
        scanner.skipWs();
        if (scanner.text[scanner.pos] === "{") {
          scanner.pos++;
          parseLoanManagerSection(scanner, (loan) => {
            result.countryDebt.set(loan.borrower, (result.countryDebt.get(loan.borrower) || 0) + loan.amount);
          });
        } else {
          scanner.skipValue();
        }
      } else if (key === "subunit_manager") {
        scanner.skipWs();
        if (scanner.text[scanner.pos] === "{") {
          scanner.pos++;
          result.subunitManagerSeen = true;
          parsePlainDatabaseSection(scanner, (number, obj) => {
            const ship = extractNavalSubunit(obj);
            if (ship) result.navalSubunits.push(ship);
            const troop = extractArmySubunit(obj);
            if (troop) result.armySubunits.push(troop);
          });
        } else {
          scanner.skipValue();
        }
      } else if (key === "trade_path_manager") {
        scanner.skipWs();
        if (scanner.text[scanner.pos] === "{") {
          scanner.pos++;
          parsePlainDatabaseSection(scanner, (number, obj) => {
            const path = extractTradePathFields(number, obj);
            if (path) result.tradePaths.push(path);
          });
        } else {
          scanner.skipValue();
        }
      } else if (key === "trade_manager") {
        scanner.skipWs();
        if (scanner.text[scanner.pos] === "{") {
          scanner.pos++;
          parsePlainDatabaseSection(scanner, (number, obj) => {
            const trade = extractTradeFields(number, obj);
            if (trade) result.trades.push(trade);
          });
        } else {
          scanner.skipValue();
        }
      }

      if (scanner.pos - lastProgressPos > PROGRESS_STEP) {
        lastProgressPos = scanner.pos;
        onProgress(scanner.pos / text.length);
      }
    }

    collapsePlayerSessions(result);
    attachLocationAssets(result);
    attachLocationBuildings(result);
    reconcileWarOccupation(result);
    attachCountryDebt(result);
    attachTradeRoutes(result);
    attachNavyCounts(result);
    attachArmyCounts(result);
    attachActiveEstateTypes(result);
    attachSocietalSourceFacts(result);

    onProgress(1);
    return result;
  }

  // played_country entries accumulate once per session (reconnects,
  // multiplayer resumes, a different human taking over an existing player's
  // country, ...), so the same country can have many entries across the
  // save's history, under different player names.
  //
  // Two DIFFERENT recency signals are available, and they are NOT
  // interchangeable - using the wrong one for the wrong comparison is a
  // real bug that shipped and was caught on a live campaign (two players
  // who both briefly took over each other's country mid-session, e.g. to
  // cover an AFK): each played_country record's own `id` field is a
  // per-PLAYER, monotonically-increasing reconnect counter (confirmed: the
  // same `id` value recurs across DIFFERENT players in the same save, so
  // it cannot be a save-wide sequence - it only ever means "the Nth time
  // THIS player connected"). Raw file/array order, by contrast, reflects
  // recency reliably WITHIN a single country's own append-ordered history
  // (confirmed against a real save: DokiDoki's sessions on a country
  // consistently came after the previous controller nurd's, in file order)
  // but does NOT reliably reflect recency ACROSS different countries -
  // each country's played_country list is its own independently-ordered
  // block, so comparing file position between an entry under country A and
  // an entry under country B tells you nothing about which happened later
  // in real time.
  //
  // So: use `id` (own-player-relative) to find each PLAYER's own truest
  // most-recent session first, regardless of which country it's under -
  // this is the step that broke before, using file order for a
  // cross-country comparison it isn't valid for, and wrongly concluding a
  // player currently split between two countries had abandoned BOTH in
  // favor of whichever the raw file happened to serialize later. THEN, if
  // that leaves two DIFFERENT players both claiming the same country as
  // their own most-recent (an ordinary single-controller handoff, e.g. one
  // player permanently replacing another - confirmed on a real save:
  // `autosave_a881d67a-...`'s DokiDoki-took-over-from-nurd case), fall back
  // to file order to pick the real current one, since THAT comparison (two
  // records under the SAME country) is exactly what file order reliably
  // orders.
  //
  // Shared between the text and binary parsers (js/clausewitz-binary.js
  // calls this too via the module's exports) since the fix applies
  // identically to both.
  function collapsePlayerSessions(result) {
    result.playerSessions = result.players.slice();
    result.playerSessions.forEach((player, idx) => {
      player.sessionIndex = idx;
    });

    const byName = new Map();
    for (const player of result.playerSessions) {
      if (!byName.has(player.name)) byName.set(player.name, []);
      byName.get(player.name).push(player);
    }
    const ownMostRecent = [...byName.values()].map((entries) => {
      entries.sort((a, b) => (b.id || 0) - (a.id || 0) || b.sessionIndex - a.sessionIndex);
      return entries[0];
    });

    const byCountry = new Map();
    for (const player of ownMostRecent) {
      if (!byCountry.has(player.countryNumber)) byCountry.set(player.countryNumber, []);
      byCountry.get(player.countryNumber).push(player);
    }
    const winners = [];
    for (const entries of byCountry.values()) {
      entries.sort((a, b) => b.sessionIndex - a.sessionIndex);
      winners.push(entries[0]);
    }

    result.players = winners;
    for (const p of result.playerSessions) delete p.sessionIndex;

    for (const player of result.players) {
      const country = result.countriesByNumber.get(player.countryNumber);
      if (country) {
        country.players.push(player.name);
        player.country = country;
      }
    }
  }

  // Joins trade_manager entries (one good flowing, with its real amount)
  // onto their trade_path_manager route (which markets it connects, whose
  // route it is, and the location-id waypoints it traverses). Only trades
  // that actually happened AND moved a real positive amount survive -
  // trade_manager also carries placeholder entries with no `effect` at all
  // (~20% of entries on a real save), which are queued/failed trades that
  // moved nothing. Shared between the text and binary parsers (js/
  // clausewitz-binary.js calls this too), same pattern as attachCountryDebt.
  function attachTradeRoutes(result) {
    const pathById = new Map((result.tradePaths || []).map((p) => [p.number, p]));
    result.tradeRoutes = [];
    for (const trade of result.trades || []) {
      if (!trade.happened || typeof trade.amount !== "number" || trade.amount <= 0) continue;
      const path = pathById.get(trade.tradePath);
      if (!path) continue;
      result.tradeRoutes.push({
        from: path.from,
        to: path.to,
        country: path.country,
        good: trade.good,
        amount: trade.amount,
        path: path.path,
      });
    }
    // The raw halves aren't needed once joined (and would just bloat the
    // IndexedDB-cached result) - tradeRoutes is the only consumer-facing form.
    delete result.tradePaths;
    delete result.trades;
  }

  // Sums each country's real fleet from its naval subunits: `navyShips` is
  // ships that were BUILT (what the "Navy Size" metric shows - levy ships
  // are excluded per user request, nobody counts a conscripted fishing
  // fleet), `navyLevyShips` keeps the excluded count for transparency.
  // Countries with no ships at all get explicit zeros so the UI reads
  // "0" rather than a missing-data dash - but only when the save actually
  // had a subunit_manager section to count from (subunitManagerSeen);
  // otherwise both stay undefined and render as "-". Shared between the
  // text and binary parsers.
  function attachNavyCounts(result) {
    if (!result.subunitManagerSeen) return;
    const built = new Map();
    const levy = new Map();
    for (const ship of result.navalSubunits || []) {
      const map = ship.levy ? levy : built;
      map.set(ship.owner, (map.get(ship.owner) || 0) + 1);
    }
    for (const country of result.countries) {
      country.navyShips = built.get(country.number) || 0;
      country.navyLevyShips = levy.get(country.number) || 0;
    }
    delete result.navalSubunits;
  }

  // Sums each country's real army from its land subunits, split into the
  // three mutually-exclusive categories extractArmySubunit identifies:
  // levies, regulars (built professional regiments), and mercenaries -
  // counted by CONTROLLER (see extractArmySubunit's comment on why, not
  // owner - matters most for mercenaries, whose `owner` is always a
  // constant sentinel). `armyTotal` is the real troop count the "Army Size"
  // metric shows (replacing the game's own `expected_army_size` formula
  // value, same fix as attachNavyCounts did for Navy Size) - same "explicit
  // zero only when subunit_manager was actually seen" rule as the navy
  // counts, so a save with no subunit data at all still renders "-" rather
  // than a fake 0. Shared between the text and binary parsers.
  function attachArmyCounts(result) {
    if (!result.subunitManagerSeen) return;
    const levies = new Map();
    const regulars = new Map();
    const mercs = new Map();
    for (const troop of result.armySubunits || []) {
      const map = troop.category === "levy" ? levies : troop.category === "mercenary" ? mercs : regulars;
      map.set(troop.controller, (map.get(troop.controller) || 0) + 1);
    }
    for (const country of result.countries) {
      country.armyLevies = levies.get(country.number) || 0;
      country.armyRegulars = regulars.get(country.number) || 0;
      country.armyMercenaries = mercs.get(country.number) || 0;
      country.armyTotal = country.armyLevies + country.armyRegulars + country.armyMercenaries;
    }
    // Kept (trimmed to just what's needed) rather than deleted like the raw
    // list used to be - js/app.js joins this against the optional, locally-
    // generated game_data/unit_sizes.json to turn regiment counts into real
    // troop headcounts. Absent that file, this is simply never consumed.
    result.armySubunitDetails = (result.armySubunits || []).map((t) => ({ controller: t.controller, category: t.category, type: t.type, strength: t.strength }));
    delete result.armySubunits;
  }

  // loan_manager.database is a flat, country-agnostic list (each entry only
  // names its `borrower`), parsed independently of the `countries` section -
  // this attaches the summed total back onto each country record after both
  // are done, order-independent of which section the save happens to list
  // first. Shared between the text and binary parsers (js/clausewitz-binary.js
  // calls this too) since the fix applies identically to both. Used by the
  // llama war-scoring engine to net loan proceeds/repayments out of a
  // treasury-swing signal - see js/llama-score.js/llama-log-machine.js's
  // economicOutcomeSignal.
  function attachCountryDebt(result) {
    for (const country of result.countries) {
      country.totalDebt = result.countryDebt.get(country.number) || 0;
    }
  }

  // government.estates is only a map of every estate identity the country
  // could use. estate_manager.database is authoritative about which ones
  // currently exist; attach that compact active list after both sections are
  // parsed so ordering in the save cannot matter.
  function attachActiveEstateTypes(result) {
    if (!result.estateManagerSeen) {
      delete result.activeEstateMemberships;
      return;
    }
    const byCountry = new Map();
    for (const entry of result.activeEstateMemberships || []) {
      if (!byCountry.has(entry.country)) byCountry.set(entry.country, new Set());
      byCountry.get(entry.country).add(entry.estateType);
    }
    for (const country of result.countries || []) {
      if (!country.modifierState) continue;
      country.modifierState.estateTypes = [...(byCountry.get(country.number) || [])].sort();
    }
    delete result.activeEstateMemberships;
  }

  // Collapse the large character/art databases to the few country facts the
  // optimizer needs before the worker result is cloned or cached. This keeps
  // the recorder payload compact while preserving definitions that can feed
  // both current and later-age societal axes.
  function attachSocietalSourceFacts(result) {
    const traitsByCharacter = new Map((result.societalCharacters || []).map((entry) => [entry.number, entry.traits]));
    const ownerByLocation = new Map((result.locations || []).map((location) => [location.number, location.owner]));
    const artCountByCountry = new Map();
    const artQualityByCountry = new Map();
    let worldArtCount = 0;
    let worldArtQuality = 0;
    for (const art of result.societalWorksOfArt || []) {
      const owner = ownerByLocation.get(art.location);
      if (typeof owner !== "number") continue;
      const quality = typeof art.quality === "number" ? art.quality : 1;
      worldArtCount += 1;
      worldArtQuality += quality;
      artCountByCountry.set(owner, (artCountByCountry.get(owner) || 0) + 1);
      artQualityByCountry.set(owner, (artQualityByCountry.get(owner) || 0) + quality);
    }
    for (const country of result.countries || []) {
      const state = country.modifierState;
      if (!state) continue;
      state.characterTraits = {
        ruler: traitsByCharacter.get(state.ruler) || [],
        heir: traitsByCharacter.get(state.heir) || [],
        consort: traitsByCharacter.get(state.consort) || [],
        regent: traitsByCharacter.get(state.regent) || [],
      };
      state.countryArtShare = worldArtCount ? (artCountByCountry.get(country.number) || 0) / worldArtCount : 0;
      state.countryArtQualityShare = worldArtQuality ? (artQualityByCountry.get(country.number) || 0) / worldArtQuality : 0;
    }
    delete result.societalCharacters;
    delete result.societalWorksOfArt;
  }

  return {
    Scanner,
    coerceScalar,
    parseSave,
    extractCountryFields,
    extractLocationFields,
    extractPopFields,
    extractDependencyFields,
    extractWarReparationsFields,
    extractEstateAssetFields,
    extractBuildingFields,
    extractNamedDefinitionFields,
    extractInternationalOrganizationFields,
    extractCharacterSocietalFields,
    extractWorkOfArtSocietalFields,
    extractMarketFields,
    extractTradePathFields,
    extractTradeFields,
    extractNavalSubunit,
    extractArmySubunit,
    extractBlackDeath,
    extractWarFields,
    extractLoanFields,
    reconcileWarOccupation,
    attachLocationAssets,
    attachLocationBuildings,
    collapsePlayerSessions,
    attachCountryDebt,
    attachTradeRoutes,
    attachNavyCounts,
    attachArmyCounts,
    attachActiveEstateTypes,
    attachSocietalSourceFacts,
    normalizeEu5Date,
  };
});
