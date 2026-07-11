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
  function extractCountryFields(number, obj) {
    const score = obj.score || {};
    const rating = score.score_rating || {};
    const rank = score.score_rank || {};
    const currency = obj.currency_data || {};
    const government = obj.government || {};
    const economy = obj.economy || {};
    const color = obj.color && Array.isArray(obj.color.values) ? obj.color.values : null;

    return {
      number,
      tag: typeof obj.country_name === "string" ? obj.country_name : String(obj.flag || ""),
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
      lastMonthGoldIncome: obj.last_month_gold_income,
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
      creditworthiness: economy.creditworthiness,
      loanCapacity: economy.loan_capacity,
      coinMinting: economy.coin_minting,
      monthlyGoldTrend: Array.isArray(economy.monthly_gold) ? economy.monthly_gold : null,
      lastMonthsTaxIncome: obj.last_months_tax_income,
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
      // Population / historical trends (one entry per in-game year)
      population: obj.last_months_population,
      historicalPopulation: Array.isArray(obj.historical_population) ? obj.historical_population : null,
      historicalTaxBase: Array.isArray(obj.historical_tax_base) ? obj.historical_tax_base : null,
      players: [],
    };
  }

  function popClassTotal(stats) {
    if (!stats || typeof stats !== "object") return undefined;
    if (typeof stats.population_ratio === "number") return stats.population_ratio;
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

  function extractMarketFields(number, obj) {
    if (!obj || typeof obj !== "object") return null;
    return {
      number,
      center: obj.center !== undefined ? obj.center : obj["#32"],
      color: colorValueToCss(obj.color),
      population: obj.population,
      locations: Array.isArray(obj.market) ? obj.market : [],
    };
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
      if (asset.roadType && typeof asset.startLocation === "number" && typeof asset.endLocation === "number") {
        for (const locId of [asset.startLocation, asset.endLocation]) {
          const loc = locByNumber.get(locId);
          if (!loc) continue;
          if (!loc.roadCounts) loc.roadCounts = {};
          loc.roadCounts[asset.roadType] = (loc.roadCounts[asset.roadType] || 0) + 1;
          loc.roadTotal = (loc.roadTotal || 0) + 1;
        }
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

  // Parses "diplomacy_manager={ 0={...} 1={...} ... dependency={...} ... }" -
  // a large section keyed mostly by country number (per-pair trust/rivalry
  // data we don't need), with subject/overlord relationships appearing as
  // repeated "dependency" entries mixed in among them. Skips everything else.
  function parseDiplomacyManagerSection(scanner, onDependency) {
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
      } else {
        scanner.skipValue();
      }
    }
  }

  function parseEstateManagerSection(scanner, onAsset) {
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
            if (asset && (asset.building || asset.roadType || typeof asset.rgo === "number")) onAsset(asset);
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

  // Parses the "countries={ tags={...} database={...} }" section. `scanner`
  // must be positioned right after the opening '{' of the countries block.
  function parseCountriesSection(scanner, onCountry) {
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
              onCountry(extractCountryFields(number, countryObj));
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
    function sumLosses(lossesObj) {
      const totals = { battle: 0, attrition: 0, capture: 0 };
      const byUnit = lossesObj && lossesObj.losses;
      if (byUnit && typeof byUnit === "object") {
        for (const unit of Object.values(byUnit)) {
          if (!unit || typeof unit !== "object") continue;
          if (typeof unit.Battle === "number") totals.battle += unit.Battle;
          if (typeof unit.Attrition === "number") totals.attrition += unit.Attrition;
          if (typeof unit.Capture === "number") totals.capture += unit.Capture;
        }
      }
      return { ...totals, total: totals.battle + totals.attrition + totals.capture };
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
  function reconcileWarOccupation(result) {
    const wars = result.wars || [];
    const controllerByLocation =
      result.locations && result.locations.length ? new Map(result.locations.map((l) => [l.number, l.controller])) : null;
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
        const side = typeof controller === "number" ? sideByCountryMap[controller] : undefined;
        if (side === "Attacker") attackerLocations++;
        else if (side === "Defender") defenderLocations++;
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

  // Top-level sections we fully or partially parse; everything else is
  // skipped without allocating.
  const BASE_TOP_LEVEL_KEYS = ["metadata", "countries", "played_country", "diplomacy_manager", "situation_manager", "disease_outbreak_manager"];

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
    const HANDLED_TOP_LEVEL_KEYS = new Set(
      BASE_TOP_LEVEL_KEYS.concat(
        includeLocations ? ["locations", "estate_manager", "building_manager", "culture_manager", "religion_manager", "market_manager", "provinces"] : [],
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
      locationAssets: [],
      buildings: [],
      cultures: [],
      religions: [],
      markets: [],
      wars: [],
      blackDeath: { status: null, start: null, end: null, identity: null, deathsByCountry: null },
      provinceOwnerByDefinition: {},
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
          });
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
      } else if (key === "diplomacy_manager") {
        scanner.skipWs();
        if (scanner.text[scanner.pos] === "{") {
          scanner.pos++;
          parseDiplomacyManagerSection(scanner, (dep) => {
            result.dependencies.push(dep);
          });
        } else {
          scanner.skipValue();
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
          parseEstateManagerSection(scanner, (asset) => {
            result.locationAssets.push(asset);
          });
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

    onProgress(1);
    return result;
  }

  // played_country entries accumulate once per session (reconnects,
  // multiplayer resumes, a different human taking over an existing player's
  // country, ...), so the same country can have many entries across the
  // save's history, under different player names. There's no timestamp on
  // these, but they're written in a stable order that does reflect recency
  // (confirmed against a real save: a country with two different named
  // players had the later-appearing name's sessions consistently
  // interleaved after the earlier one's) - so keep only the LAST entry for
  // each country as that country's current controller, dropping any earlier
  // session under a different name.
  //
  // That per-country collapse alone still leaves a gap: a player who
  // abandoned an earlier country for a new one, with nobody ever taking
  // over the old one since, ends up as the "last entry" for BOTH countries
  // independently - each country's own history looks like a valid single-
  // controller record in isolation. Confirmed against a real save
  // (`autosave_a881d67a-...`): DokiDoki's last session on SAR (Sardinia)
  // and their later session on NED (Netherlands) both survived the
  // per-country collapse, so the map labeled DokiDoki over BOTH countries'
  // capitals and the Black Death/Players tables listed them twice. Since
  // playerSessions preserves file order (= recency, per above) across
  // EVERY country's history, not just one country's, a second pass can
  // catch this: for any player name that still controls more than one
  // country after the per-country collapse, keep only the most recent of
  // those and drop the player from the older country/countries entirely
  // (there's no reliable "who controls it now instead" signal, so it's left
  // with no current player rather than a stale/duplicate one).
  //
  // Shared between the text and binary parsers (js/clausewitz-binary.js
  // calls this too via the module's exports) since the fix applies
  // identically to both.
  function collapsePlayerSessions(result) {
    result.playerSessions = result.players.slice();
    const lastPlayerByCountry = new Map();
    result.playerSessions.forEach((player, idx) => {
      player.sessionIndex = idx;
      lastPlayerByCountry.set(player.countryNumber, player);
    });
    const collapsed = [...lastPlayerByCountry.values()];

    const byName = new Map();
    for (const player of collapsed) {
      if (!byName.has(player.name)) byName.set(player.name, []);
      byName.get(player.name).push(player);
    }
    const dropped = new Set();
    for (const entries of byName.values()) {
      if (entries.length <= 1) continue;
      entries.sort((a, b) => a.sessionIndex - b.sessionIndex);
      for (let i = 0; i < entries.length - 1; i++) dropped.add(entries[i]);
    }
    result.players = collapsed.filter((p) => !dropped.has(p));
    for (const p of result.playerSessions) delete p.sessionIndex;

    for (const player of result.players) {
      const country = result.countriesByNumber.get(player.countryNumber);
      if (country) {
        country.players.push(player.name);
        player.country = country;
      }
    }
  }

  return {
    Scanner,
    coerceScalar,
    parseSave,
    extractCountryFields,
    extractLocationFields,
    extractDependencyFields,
    extractEstateAssetFields,
    extractBuildingFields,
    extractNamedDefinitionFields,
    extractMarketFields,
    extractBlackDeath,
    extractWarFields,
    reconcileWarOccupation,
    attachLocationAssets,
    attachLocationBuildings,
    collapsePlayerSessions,
  };
});
