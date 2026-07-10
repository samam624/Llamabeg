// Parser for EU5's compressed (binary-tokenized) save format. Produces the
// same result shape as js/clausewitz.js's parseSave() for melted text saves,
// so the rest of the app doesn't need to care which format was uploaded.
//
// Format (reverse-engineered against a real save, cross-checked field by
// field against that same save's melted plaintext - see test/run-binary.js,
// which validates this module's output against js/clausewitz.js's text
// parser on the same save):
//   "SAV02" + "00"(text) | "03"(binary) + ... + "\n"
//   [binary metadata block, same encoding as gamestate]
//   [zip: "gamestate" entry (deflate), "string_lookup" entry (deflate)]
//
// Token grammar inside metadata/gamestate (all integers little-endian):
//   0x0003 / 0x0004        object/array open / close
//   0x0001                 "=" (only appears between a key and its value)
//   0x000e                 bool, 1 byte (00/01)
//   0x000c/0x0014           int32, 4 bytes
//   0x029c                  int (up to 2^53), 8 bytes - a wider sibling of
//                           0x000c/0x0014, not the same width despite the
//                           surface resemblance; used for values that can
//                           exceed int32 range (e.g. situation_manager's
//                           gag_total_tax.identity counter)
//   0x000f/0x0017          Hollerith string (2-byte length + utf8 bytes)
//   0x0167                 fixed-point, 8 bytes / 100000
//   0x0d40 / 0x0d43        string_lookup ref, 1-byte index (0x0d43 seen on
//                          pre-1.3 saves only, e.g. top-level manager keys)
//   0x0d3e / 0x0d44        string_lookup ref, 2-byte index (value / name use)
//   0x0d48-0x0d4e          fixed-point, 1-7 bytes / 100000 (positive)
//   0x0d4f-0x0d56          fixed-point, 1-7 bytes / 100000 (negated)
//   0x0243                 RGB color tag, followed by a 0x0003 triple
//   anything else          a fixed ID: either a well-known key (see
//                          eu5-fixed-ids.js) or, in value position, an
//                          opaque enum-like identifier we don't resolve.
// A key can ALSO be an int32-coded token (used for numeric map keys like
// countries.database's country numbers) or a string_lookup ref (used for
// keys that aren't common enough to deserve a fixed ID, e.g. top-level
// manager names). Every "key candidate" is resolved the same way regardless
// of position, then whatever follows determines whether it's a key (EQUALS
// follows) or a bare array element (it doesn't).
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./eu5-fixed-ids.js"), require("./clausewitz.js"));
  } else {
    root.ClausewitzBinary = factory(root.EU5FixedIds, root.Clausewitz);
  }
})(typeof self !== "undefined" ? self : this, function (EU5FixedIds, Clausewitz) {
  "use strict";

  const STRREF8 = 0x0d40;
  // A second 1-byte-index string_lookup ref code, distinct from STRREF8 -
  // seen on pre-1.3 saves (e.g. the "resolution_manager" top-level key).
  // Byte-verified: 0x0d43 followed by a 1-byte index that resolves to
  // "resolution_manager" in string_lookup, immediately followed by EQUALS
  // at the exact expected offset - not a coincidence at that specificity.
  const STRREF8_ALT = 0x0d43;
  const STRREF16 = 0x0d3e;
  const STRREF16_NAME = 0x0d44;
  // A dedicated zero-payload "the value is exactly 0" code, immediately
  // before the positive fixed-point range - byte-verified: every sampled
  // occurrence is directly followed by a valid next token (CLOSE, a fresh
  // STRREF16 key, ...) with no gap, and melted text confirms the
  // corresponding field is 0 (e.g. expected_army_size=0). Worth a dedicated
  // code since 0 is an extremely common value.
  const FIXED_POINT_ZERO = 0x0d47;
  const OPEN = 0x0003;
  const CLOSE = 0x0004;
  const EQUALS = 0x0001;

  function makeDecoder(buf, strings, opts) {
    let pos = 0;
    // Called with a resolved key name whenever skipBody identifies a key at
    // ANY nesting depth (not just true top level). Returns true if it
    // handled (and fully consumed) the value itself, false to skip normally.
    // Exists because some saves nest sections we care about (countries,
    // played_country) one level deeper than expected - see the note on
    // parseCompressedSave for why we can't just trust a fixed depth.
    const onSpecialKey = opts && opts.onSpecialKey;
    const debugRing = opts && opts.debug ? [] : null;
    const debugAnomalies = opts && opts.debug ? [] : null;
    // Debug-only: throws StopAtPos once pos reaches this, so callers can
    // inspect the ring buffer's context leading up to an arbitrary position
    // in a huge section without walking (and ring-evicting past) millions
    // of tokens first. See test/debug-desync*.js.
    const stopAtPos = opts && opts.stopAtPos;
    const DEBUG_RING_SIZE = 80;
    function debugRecord(entry) {
      if (!debugRing) return;
      if (entry.type && entry.type.indexOf("UNKNOWN") === 0) {
        debugAnomalies.push(entry); // never evicted, for anomaly scans
      }
      debugRing.push(entry);
      if (debugRing.length > DEBUG_RING_SIZE) debugRing.shift();
    }

    function lookupStr(idx) {
      return strings && strings[idx] !== undefined ? strings[idx] : `#strref:${idx}`;
    }

    // Resolves a key-or-value-position token to a string (string_lookup
    // ref, or an inline Hollerith string - 1.0.x saves spell out keys like
    // "resolution_manager" in full instead of using a string_lookup ref),
    // a number/bool/fixed-point (scalar payload types - not known to be
    // used as real keys by the schema, but decoding them fully here rather
    // than assuming zero payload keeps the key-vs-bare-value ambiguity
    // check below always looking at a true token boundary), or a fixed-ID
    // key name / "#hex" placeholder object. Advances `pos` past the whole
    // token+payload either way.
    function resolveToken() {
      const code = buf.getUint16(pos, true);
      pos += 2;
      if (code === STRREF8 || code === STRREF8_ALT) {
        const idx = buf.getUint8(pos);
        pos += 1;
        return lookupStr(idx);
      }
      if (code === STRREF16 || code === STRREF16_NAME) {
        const idx = buf.getUint16(pos, true);
        pos += 2;
        return lookupStr(idx);
      }
      if (code === 0x000c || code === 0x0014) {
        const v = buf.getInt32(pos, true);
        pos += 4;
        return v;
      }
      return readScalarValue(code);
    }

    function readScalarValue(code) {
      if (code === 0x000e) {
        const v = buf.getUint8(pos);
        pos += 1;
        return v === 1;
      }
      if (code === 0x000c || code === 0x0014) {
        const v = buf.getInt32(pos, true);
        pos += 4;
        return v;
      }
      // 0x029c: an 8-byte (not 4-byte) integer - despite looking like a
      // sibling of 0x000c/0x0014 at a glance, it's a distinct, wider code.
      // Byte-verified: situation_manager's gag_total_tax.identity field (a
      // monotonically-growing counter that exceeds int32 range - observed
      // values in the tens of billions across real saves) decodes to
      // exactly its expected melted-text value only when this code's
      // payload is read as 8 bytes; reading 4 left 4 real payload bytes
      // unconsumed, which then got misread as a bogus extra token,
      // silently eating the section's real CLOSE and desyncing everything
      // after it (the root cause of a save going to 0 countries once
      // includeLocations/includeWars added enough scan surface to reach
      // this section instead of skipping it wholesale).
      if (code === 0x029c) {
        const lo = buf.getUint32(pos, true);
        const hi = buf.getInt32(pos + 4, true);
        pos += 8;
        return hi * 4294967296 + lo;
      }
      if (code === 0x000f || code === 0x0017) {
        const len = buf.getUint16(pos, true);
        pos += 2;
        const s = utf8Decode(buf, pos, len);
        pos += len;
        return s;
      }
      if (code === 0x0167) {
        const lo = buf.getUint32(pos, true);
        const hi = buf.getInt32(pos + 4, true);
        pos += 8;
        return (hi * 4294967296 + lo) / 100000.0;
      }
      if (code === FIXED_POINT_ZERO) return 0;
      if (code >= 0x0d48 && code <= 0x0d4e) {
        const n = code - 0x0d48 + 1;
        let v = 0;
        for (let i = n - 1; i >= 0; i--) v = v * 256 + buf.getUint8(pos + i);
        pos += n;
        return v / 100000.0;
      }
      if (code >= 0x0d4f && code <= 0x0d56) {
        const n = code - 0x0d4f + 1;
        let v = 0;
        for (let i = n - 1; i >= 0; i--) v = v * 256 + buf.getUint8(pos + i);
        pos += n;
        return -v / 100000.0;
      }
      if (code === 0x0243) {
        const nextCode = buf.getUint16(pos, true);
        pos += 2;
        if (nextCode !== OPEN) throw new Error(`expected OPEN after COLOR_RGB at ${pos - 2}`);
        return { colorSpace: "rgb", values: decodeBody() };
      }
      // Most fixed-ID tokens only ever appear in key position (resolved via
      // keyToPropName), but a few double as enum-tag VALUES too - e.g.
      // situation_manager's black_death.variables.data[].data.type=
      // disease_outbreak resolves here, not through keyToPropName, since
      // it's a value. Same global token table either way (one token per
      // string, regardless of position) - fall back to the sentinel object
      // only for codes truly not in the table yet.
      const knownName = EU5FixedIds[code.toString(16)];
      if (knownName) return knownName;
      debugRecord({ pos: pos - 2, type: "UNKNOWN_SCALAR_VALUE", code });
      return { fixedNum: code };
    }

    function skipScalarValue(code) {
      if (code === 0x000e) {
        pos += 1;
        return;
      }
      if (code === 0x000c || code === 0x0014) {
        pos += 4;
        return;
      }
      if (code === 0x029c) {
        pos += 8;
        return;
      }
      if (code === 0x000f || code === 0x0017) {
        pos += 2 + buf.getUint16(pos, true);
        return;
      }
      if (code === 0x0167) {
        pos += 8;
        return;
      }
      if (code === FIXED_POINT_ZERO) return;
      if (code >= 0x0d48 && code <= 0x0d4e) {
        pos += code - 0x0d48 + 1;
        return;
      }
      if (code >= 0x0d4f && code <= 0x0d56) {
        pos += code - 0x0d4f + 1;
        return;
      }
      if (code === 0x0243) {
        const nextCode = buf.getUint16(pos, true);
        pos += 2;
        if (nextCode !== OPEN) throw new Error(`expected OPEN after COLOR_RGB at ${pos - 2}`);
        skipBody();
        return;
      }
      debugRecord({ pos: pos - 2, type: "UNKNOWN_SKIP", code });
      // unresolved fixed ID, zero extra bytes
    }

    function readBareValue() {
      const code = buf.getUint16(pos, true);
      if (code === OPEN) {
        pos += 2;
        return decodeBody();
      }
      if (code === STRREF8 || code === STRREF8_ALT || code === STRREF16 || code === STRREF16_NAME) {
        return resolveToken();
      }
      pos += 2;
      return readScalarValue(code);
    }

    function skipBareValue() {
      const code = buf.getUint16(pos, true);
      if (code === OPEN) {
        pos += 2;
        skipBody();
        return;
      }
      if (code === STRREF8 || code === STRREF8_ALT) {
        pos += 3;
        return;
      }
      if (code === STRREF16 || code === STRREF16_NAME) {
        pos += 4;
        return;
      }
      pos += 2;
      skipScalarValue(code);
    }

    function addEntry(obj, key, val) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        if (Array.isArray(obj[key])) obj[key].push(val);
        else obj[key] = [obj[key], val];
      } else {
        obj[key] = val;
      }
    }

    function keyToPropName(resolved) {
      if (typeof resolved === "string" || typeof resolved === "number") return resolved;
      if (typeof resolved !== "object" || resolved === null || typeof resolved.fixedNum !== "number") {
        // A bool or a decoded COLOR_RGB object landed in key position -
        // never seen in practice, but resolveToken() now fully decodes
        // every scalar type, so it's reachable in principle. Fall back to
        // a stable string rather than crashing on a missing .fixedNum.
        return "#unexpected:" + JSON.stringify(resolved);
      }
      const hex = resolved.fixedNum.toString(16);
      return EU5FixedIds[hex] || "#" + hex;
    }

    function decodeBody() {
      const items = [];
      const named = {};
      let hasNamed = false;
      while (true) {
        const peek = buf.getUint16(pos, true);
        if (peek === CLOSE) {
          pos += 2;
          break;
        }
        if (peek === OPEN) {
          pos += 2;
          items.push(decodeBody());
          continue;
        }
        const savedPos = pos;
        const resolved = resolveToken();
        const maybeEquals = buf.getUint16(pos, true);
        if (maybeEquals === EQUALS) {
          pos += 2;
          const value = readBareValue();
          addEntry(named, keyToPropName(resolved), value);
          hasNamed = true;
        } else if (typeof resolved !== "object") {
          items.push(resolved);
        } else {
          pos = savedPos;
          items.push(readBareValue());
        }
      }
      if (!hasNamed) return items;
      if (items.length === 0) return named;
      named.__items = items;
      return named;
    }

    function skipBody(depth) {
      depth = depth || 1;
      while (true) {
        if (stopAtPos && pos >= stopAtPos) throw new Error("StopAtPos");
        const tokenStart = pos;
        const peek = buf.getUint16(pos, true);
        if (peek === CLOSE) {
          pos += 2;
          debugRecord({ pos: tokenStart, depth, type: "CLOSE" });
          return;
        }
        if (peek === OPEN) {
          pos += 2;
          debugRecord({ pos: tokenStart, depth, type: "OPEN" });
          skipBody(depth + 1);
          continue;
        }
        const savedPos = pos;
        const resolved = resolveToken();
        const maybeEquals = buf.getUint16(pos, true);
        if (maybeEquals === EQUALS) {
          pos += 2;
          const keyName = keyToPropName(resolved);
          debugRecord({ pos: tokenStart, depth, type: "KEY", key: keyName });
          if (!onSpecialKey || !onSpecialKey(keyName)) {
            skipBareValue();
          }
        } else if (typeof resolved !== "object") {
          debugRecord({ pos: tokenStart, depth, type: "BAREVALUE", value: resolved });
          // already consumed
        } else {
          pos = savedPos;
          debugRecord({ pos: tokenStart, depth, type: "BAREVALUE_FIXEDID", fixedNum: resolved.fixedNum });
          skipBareValue();
        }
      }
    }

    return {
      get pos() {
        return pos;
      },
      getDebugRing() {
        return debugRing ? debugRing.slice() : [];
      },
      getDebugAnomalies() {
        return debugAnomalies ? debugAnomalies.slice() : [];
      },
      set pos(v) {
        pos = v;
      },
      resolveToken,
      readBareValue,
      skipBareValue,
      decodeBody,
      skipBody,
      keyToPropName,
    };
  }

  function utf8Decode(dataView, offset, len) {
    const bytes = new Uint8Array(dataView.buffer, dataView.byteOffset + offset, len);
    if (typeof TextDecoder !== "undefined") {
      return new TextDecoder("utf-8").decode(bytes);
    }
    return Buffer.from(bytes).toString("utf8"); // Node fallback
  }

  function parseStringLookup(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const strings = [];
    let p = 5; // 5-byte header, purpose unknown
    while (p < bytes.length) {
      const len = view.getUint16(p, true);
      strings.push(utf8Decode(view, p + 2, len));
      p += 2 + len;
    }
    return strings;
  }

  // --- zip local-file-header extraction (no external deps) ---

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== "undefined") {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    // Node test/dev fallback.
    const zlib = require("zlib");
    return new Uint8Array(zlib.inflateRawSync(Buffer.from(bytes)));
  }

  async function extractZipEntries(bytes, names) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entries = {};
    let offset = 0;
    while (offset < bytes.length && view.getUint32(offset, true) === 0x04034b50) {
      const compMethod = view.getUint16(offset + 8, true);
      const compSize = view.getUint32(offset + 18, true);
      const uncompSize = view.getUint32(offset + 22, true);
      const nameLen = view.getUint16(offset + 26, true);
      const extraLen = view.getUint16(offset + 28, true);
      const name = utf8Decode(view, offset + 30, nameLen);
      const dataStart = offset + 30 + nameLen + extraLen;
      const compData = bytes.subarray(dataStart, dataStart + compSize);
      if (names.includes(name)) {
        const data = compMethod === 0 ? compData : await inflateRaw(compData);
        if (data.length !== uncompSize) {
          throw new Error(`zip entry "${name}" decompressed to ${data.length} bytes, expected ${uncompSize}`);
        }
        entries[name] = data;
      }
      offset = dataStart + compSize;
    }
    return entries;
  }

  // --- top-level orchestration, mirroring Clausewitz.parseSave()'s shape ---

  // EU5 dates are stored as hours elapsed since year -5000 (ignoring leap
  // years): ((year + 5000) * 365 + julian_day) * 24 + hour. Verified against
  // the melted text of a real save (56213844 -> "1417.2.8.12").
  const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  function dateFromHours(totalHours) {
    const hourOfDay = totalHours % 24;
    const totalDays = (totalHours - hourOfDay) / 24;
    const yearPlus5000 = Math.floor(totalDays / 365);
    let day = totalDays - yearPlus5000 * 365; // 0-indexed Julian day
    const year = yearPlus5000 - 5000;
    let month = 0;
    while (day >= MONTH_LENGTHS[month]) {
      day -= MONTH_LENGTHS[month];
      month++;
    }
    const base = `${year}.${month + 1}.${day + 1}`;
    return hourOfDay === 0 ? base : `${base}.${hourOfDay}`;
  }

  function parseMetadataBlock(bytes, strings) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const dec = makeDecoder(view, strings);
    dec.pos = 4; // skip [id][equals] preamble
    const valCode = view.getUint16(dec.pos, true);
    dec.pos += 2;
    if (valCode !== OPEN) throw new Error("expected metadata value to be a subobject");
    const metadata = dec.decodeBody();
    if (typeof metadata.date === "number") metadata.date = dateFromHours(metadata.date);
    return metadata;
  }

  function parseCountriesSection(dec, view, onCountry) {
    dec.pos += 2; // consume OPEN already peeked by caller
    while (true) {
      const peek = view.getUint16(dec.pos, true);
      if (peek === CLOSE) {
        dec.pos += 2;
        break;
      }
      const resolved = dec.resolveToken();
      const key = dec.keyToPropName(resolved);
      const eq = view.getUint16(dec.pos, true);
      if (eq !== EQUALS) throw new Error(`countries section desync at ${dec.pos}`);
      dec.pos += 2;

      if (key === "database") {
        const openCode = view.getUint16(dec.pos, true);
        dec.pos += 2;
        if (openCode !== OPEN) throw new Error("expected database to be a subobject");
        while (true) {
          const p2 = view.getUint16(dec.pos, true);
          if (p2 === CLOSE) {
            dec.pos += 2;
            break;
          }
          const numResolved = dec.resolveToken();
          const eq2 = view.getUint16(dec.pos, true);
          if (eq2 !== EQUALS) throw new Error(`countries.database desync at ${dec.pos}`);
          dec.pos += 2;
          const countryObj = dec.readBareValue();
          // Some database entries aren't full country objects - e.g. a
          // tombstone/redirect for a merged-away country, encoded as a bare
          // unresolved fixed-ID enum value rather than a subobject. That
          // decodes to the same {fixedNum} sentinel readScalarValue()
          // returns for any unmapped value-position code, which is never a
          // real decoded key (keyToPropName never produces it), so it's a
          // safe way to distinguish a placeholder from an actual country.
          if (countryObj && typeof countryObj === "object" && !Array.isArray(countryObj) && !("fixedNum" in countryObj)) {
            onCountry(Clausewitz.extractCountryFields(numResolved, countryObj));
          }
        }
      } else {
        dec.skipBareValue();
      }
    }
  }

  // Mirrors parseCountriesSection, but for "locations={ locations={...} }" -
  // a flat map of ~28,573 entries in a large save, keyed by the same
  // 1-based location numbering used by the game's map files (see
  // js/clausewitz.js's parseLocationsSection for the text-format twin and
  // tools/build-location-data.js for how that numbering was confirmed).
  function parseLocationsSection(dec, view, onLocation) {
    dec.pos += 2; // consume OPEN already peeked by caller
    while (true) {
      const peek = view.getUint16(dec.pos, true);
      if (peek === CLOSE) {
        dec.pos += 2;
        break;
      }
      const resolved = dec.resolveToken();
      const key = dec.keyToPropName(resolved);
      const eq = view.getUint16(dec.pos, true);
      if (eq !== EQUALS) throw new Error(`locations section desync at ${dec.pos}`);
      dec.pos += 2;

      if (key === "locations") {
        const openCode = view.getUint16(dec.pos, true);
        dec.pos += 2;
        if (openCode !== OPEN) throw new Error("expected locations.locations to be a subobject");
        while (true) {
          const p2 = view.getUint16(dec.pos, true);
          if (p2 === CLOSE) {
            dec.pos += 2;
            break;
          }
          const numResolved = dec.resolveToken();
          const eq2 = view.getUint16(dec.pos, true);
          if (eq2 !== EQUALS) throw new Error(`locations.locations desync at ${dec.pos}`);
          dec.pos += 2;
          const locObj = dec.readBareValue();
          if (locObj && typeof locObj === "object" && !Array.isArray(locObj) && !("fixedNum" in locObj)) {
            onLocation(Clausewitz.extractLocationFields(numResolved, locObj));
          }
        }
      } else {
        dec.skipBareValue();
      }
    }
  }

  // Mirrors parseLocationsSection, but for "diplomacy_manager={ 0={...}
  // dependency={...} ... }" - most entries are keyed by country number (a
  // large per-pair trust/rivalry section we don't need and skip), with
  // subject/overlord relationships appearing as repeated "dependency" keys
  // mixed in among them. See js/clausewitz.js's parseDiplomacyManagerSection
  // for the text-format twin.
  function parseDiplomacyManagerSection(dec, view, onDependency) {
    dec.pos += 2; // consume OPEN already peeked by caller
    while (true) {
      const peek = view.getUint16(dec.pos, true);
      if (peek === CLOSE) {
        dec.pos += 2;
        break;
      }
      const resolved = dec.resolveToken();
      const key = dec.keyToPropName(resolved);
      const eq = view.getUint16(dec.pos, true);
      if (eq !== EQUALS) throw new Error(`diplomacy_manager desync at ${dec.pos}`);
      dec.pos += 2;

      if (key === "dependency") {
        const obj = dec.readBareValue();
        if (obj && typeof obj === "object" && !Array.isArray(obj) && !("fixedNum" in obj)) {
          const dep = Clausewitz.extractDependencyFields(obj);
          if (typeof dep.overlord === "number" && typeof dep.subject === "number") onDependency(dep);
        }
      } else {
        dec.skipBareValue();
      }
    }
  }

  function parseEstateManagerSection(dec, view, onAsset) {
    dec.pos += 2; // consume OPEN already peeked by caller
    while (true) {
      const peek = view.getUint16(dec.pos, true);
      if (peek === CLOSE) {
        dec.pos += 2;
        break;
      }
      const resolved = dec.resolveToken();
      const key = dec.keyToPropName(resolved);
      const eq = view.getUint16(dec.pos, true);
      if (eq !== EQUALS) throw new Error(`estate_manager desync at ${dec.pos}`);
      dec.pos += 2;

      if (key === "database") {
        const openCode = view.getUint16(dec.pos, true);
        dec.pos += 2;
        if (openCode !== OPEN) throw new Error("expected estate_manager.database to be a subobject");
        while (true) {
          const p2 = view.getUint16(dec.pos, true);
          if (p2 === CLOSE) {
            dec.pos += 2;
            break;
          }
          const numResolved = dec.resolveToken();
          const eq2 = view.getUint16(dec.pos, true);
          if (eq2 !== EQUALS) throw new Error(`estate_manager.database desync at ${dec.pos}`);
          dec.pos += 2;
          const assetObj = dec.readBareValue();
          if (assetObj && typeof assetObj === "object" && !Array.isArray(assetObj) && !("fixedNum" in assetObj)) {
            const asset = Clausewitz.extractEstateAssetFields(numResolved, assetObj);
            if (asset && (asset.building || asset.roadType || typeof asset.rgo === "number")) onAsset(asset);
          }
        }
      } else {
        dec.skipBareValue();
      }
    }
  }

  function parseNamedDatabaseSection(dec, view, sectionName, onEntry) {
    dec.pos += 2; // consume OPEN already peeked by caller
    while (true) {
      const peek = view.getUint16(dec.pos, true);
      if (peek === CLOSE) {
        dec.pos += 2;
        break;
      }
      const resolved = dec.resolveToken();
      const key = dec.keyToPropName(resolved);
      const eq = view.getUint16(dec.pos, true);
      if (eq !== EQUALS) throw new Error(`${sectionName} desync at ${dec.pos}`);
      dec.pos += 2;

      if (key === "database") {
        const openCode = view.getUint16(dec.pos, true);
        dec.pos += 2;
        if (openCode !== OPEN) throw new Error(`expected ${sectionName}.database to be a subobject`);
        while (true) {
          const p2 = view.getUint16(dec.pos, true);
          if (p2 === CLOSE) {
            dec.pos += 2;
            break;
          }
          const numResolved = dec.resolveToken();
          const eq2 = view.getUint16(dec.pos, true);
          if (eq2 !== EQUALS) throw new Error(`${sectionName}.database desync at ${dec.pos}`);
          dec.pos += 2;
          const obj = dec.readBareValue();
          if (obj && typeof obj === "object" && !Array.isArray(obj) && !("fixedNum" in obj)) {
            const entry = Clausewitz.extractNamedDefinitionFields(numResolved, obj);
            if (entry) onEntry(entry);
          }
        }
      } else {
        dec.skipBareValue();
      }
    }
  }

  function parseMarketManagerSection(dec, view, onMarket) {
    dec.pos += 2; // consume OPEN already peeked by caller
    while (true) {
      const peek = view.getUint16(dec.pos, true);
      if (peek === CLOSE) {
        dec.pos += 2;
        break;
      }
      const resolved = dec.resolveToken();
      const key = dec.keyToPropName(resolved);
      const eq = view.getUint16(dec.pos, true);
      if (eq !== EQUALS) throw new Error(`market_manager desync at ${dec.pos}`);
      dec.pos += 2;

      if (key === "database") {
        const openCode = view.getUint16(dec.pos, true);
        dec.pos += 2;
        if (openCode !== OPEN) throw new Error("expected market_manager.database to be a subobject");
        while (true) {
          const p2 = view.getUint16(dec.pos, true);
          if (p2 === CLOSE) {
            dec.pos += 2;
            break;
          }
          const numResolved = dec.resolveToken();
          const eq2 = view.getUint16(dec.pos, true);
          if (eq2 !== EQUALS) throw new Error(`market_manager.database desync at ${dec.pos}`);
          dec.pos += 2;
          const obj = dec.readBareValue();
          if (obj && typeof obj === "object" && !Array.isArray(obj) && !("fixedNum" in obj)) {
            const entry = Clausewitz.extractMarketFields(numResolved, obj);
            if (entry) onMarket(entry);
          }
        }
      } else {
        dec.skipBareValue();
      }
    }
  }

  // Mirrors js/clausewitz.js's extractBlackDeath, but start/end arrive as
  // raw hour counts here (same encoding as metadata.date) rather than
  // pre-formatted date strings.
  function extractBlackDeathBinary(obj) {
    if (!obj || typeof obj !== "object") return { status: null, start: null, end: null, identity: null, deathsByCountry: null };
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
      start: typeof obj.start === "number" ? dateFromHours(obj.start) : null,
      end: typeof obj.end === "number" ? dateFromHours(obj.end) : null,
      identity,
      deathsByCountry: null,
    };
  }

  // Mirrors js/clausewitz.js's parseDiseaseOutbreakManagerSection: walks
  // disease_outbreak_manager.data (skipping the huge per-location resistance/
  // immunity "locations" sub-object each entry also carries - can be 100k+
  // lines melted, the reason this section isn't decoded generically) and
  // sums each entry's "countries" (per-country death tallies) for the
  // outbreak matching targetIdentity, the same selective-then-discard
  // treatment war_manager.database entries get.
  function parseDiseaseOutbreakManagerSection(dec, view, targetIdentity) {
    const deathsByCountry = {};

    function parseDeathEntry() {
      let diseaseOutbreak = null;
      let amount = null;
      while (true) {
        const peek = view.getUint16(dec.pos, true);
        if (peek === CLOSE) {
          dec.pos += 2;
          break;
        }
        const resolved = dec.resolveToken();
        const k = dec.keyToPropName(resolved);
        dec.pos += 2; // EQUALS
        if (k === "disease_outbreak") {
          const v = dec.readBareValue();
          diseaseOutbreak = typeof v === "number" ? v : null;
        } else if (k === "deaths") {
          const v = dec.readBareValue();
          amount = typeof v === "number" ? v : null;
        } else {
          dec.skipBareValue();
        }
      }
      return { diseaseOutbreak, amount };
    }

    function parseCountryEntry() {
      let county = null;
      let total = 0;
      while (true) {
        const peek = view.getUint16(dec.pos, true);
        if (peek === CLOSE) {
          dec.pos += 2;
          break;
        }
        const resolved = dec.resolveToken();
        const k = dec.keyToPropName(resolved);
        dec.pos += 2; // EQUALS
        if (k === "county") {
          const v = dec.readBareValue();
          county = typeof v === "number" ? v : null;
        } else if (k === "deaths") {
          const openCode = view.getUint16(dec.pos, true);
          dec.pos += 2;
          if (openCode === OPEN) {
            while (true) {
              const p2 = view.getUint16(dec.pos, true);
              if (p2 === CLOSE) {
                dec.pos += 2;
                break;
              }
              if (p2 !== OPEN) {
                // shouldn't happen (each death entry is a subobject) - bail
                dec.skipBareValue();
                continue;
              }
              dec.pos += 2;
              const d = parseDeathEntry();
              if (d.diseaseOutbreak === targetIdentity && typeof d.amount === "number") total += d.amount;
            }
          }
        } else {
          dec.skipBareValue();
        }
      }
      if (county !== null) deathsByCountry[county] = (deathsByCountry[county] || 0) + total;
    }

    function parseTypeEntry() {
      while (true) {
        const peek = view.getUint16(dec.pos, true);
        if (peek === CLOSE) {
          dec.pos += 2;
          break;
        }
        const resolved = dec.resolveToken();
        const k = dec.keyToPropName(resolved);
        dec.pos += 2; // EQUALS
        if (k === "countries") {
          const openCode = view.getUint16(dec.pos, true);
          dec.pos += 2;
          if (openCode === OPEN) {
            while (true) {
              const p2 = view.getUint16(dec.pos, true);
              if (p2 === CLOSE) {
                dec.pos += 2;
                break;
              }
              if (p2 !== OPEN) {
                dec.skipBareValue();
                continue;
              }
              dec.pos += 2;
              parseCountryEntry();
            }
          }
        } else {
          // "locations" (huge) / "type" / "date" / "current" - none needed.
          dec.skipBareValue();
        }
      }
    }

    dec.pos += 2; // consume OPEN already peeked by caller
    while (true) {
      const peek = view.getUint16(dec.pos, true);
      if (peek === CLOSE) {
        dec.pos += 2;
        break;
      }
      const resolved = dec.resolveToken();
      const key = dec.keyToPropName(resolved);
      dec.pos += 2; // EQUALS
      if (key === "data") {
        const openCode = view.getUint16(dec.pos, true);
        dec.pos += 2;
        if (openCode === OPEN) {
          while (true) {
            const p2 = view.getUint16(dec.pos, true);
            if (p2 === CLOSE) {
              dec.pos += 2;
              break;
            }
            if (p2 !== OPEN) {
              dec.skipBareValue();
              continue;
            }
            dec.pos += 2;
            parseTypeEntry();
          }
        }
      } else {
        dec.skipBareValue();
      }
    }

    return deathsByCountry;
  }

  // Mirrors js/clausewitz.js's parseProvincesSection: each provinces.database
  // entry is fully decoded then immediately reduced to {definition, owner}
  // and discarded (not huge like disease_outbreak_manager's per-location
  // blob, so no field-by-field selective walk needed - same treatment as
  // war_manager.database).
  function parseProvincesSection(dec, view, onProvince) {
    dec.pos += 2; // consume OPEN already peeked by caller
    while (true) {
      const peek = view.getUint16(dec.pos, true);
      if (peek === CLOSE) {
        dec.pos += 2;
        break;
      }
      const resolved = dec.resolveToken();
      const key = dec.keyToPropName(resolved);
      const eq = view.getUint16(dec.pos, true);
      if (eq !== EQUALS) throw new Error(`provinces desync at ${dec.pos}`);
      dec.pos += 2;

      if (key === "database") {
        const openCode = view.getUint16(dec.pos, true);
        dec.pos += 2;
        if (openCode !== OPEN) throw new Error("expected provinces.database to be a subobject");
        while (true) {
          const p2 = view.getUint16(dec.pos, true);
          if (p2 === CLOSE) {
            dec.pos += 2;
            break;
          }
          dec.resolveToken(); // entry number - not needed
          const eq2 = view.getUint16(dec.pos, true);
          if (eq2 !== EQUALS) throw new Error(`provinces.database desync at ${dec.pos}`);
          dec.pos += 2;
          const obj = dec.readBareValue();
          if (obj && typeof obj === "object" && !Array.isArray(obj) && !("fixedNum" in obj)) {
            const definition = typeof obj.province_definition === "string" ? obj.province_definition : null;
            const owner = typeof obj.owner === "number" ? obj.owner : null;
            if (definition) onProvince({ definition, owner });
          }
        }
      } else {
        dec.skipBareValue();
      }
    }
  }

  // situation_manager tracks ~20 scripted historical events by name (the
  // names themselves are string_lookup refs, not fixed IDs, so they
  // resolve to real strings directly); only black_death is read here, the
  // rest stay skipped. See js/clausewitz.js's parseSave for the text-format
  // twin.
  function parseSituationManagerSection(dec, view, onBlackDeath) {
    dec.pos += 2; // consume OPEN already peeked by caller
    while (true) {
      const peek = view.getUint16(dec.pos, true);
      if (peek === CLOSE) {
        dec.pos += 2;
        break;
      }
      const resolved = dec.resolveToken();
      const key = dec.keyToPropName(resolved);
      const eq = view.getUint16(dec.pos, true);
      if (eq !== EQUALS) throw new Error(`situation_manager desync at ${dec.pos}`);
      dec.pos += 2;

      if (key === "black_death") {
        const obj = dec.readBareValue();
        if (obj && typeof obj === "object" && !Array.isArray(obj) && !("fixedNum" in obj)) onBlackDeath(obj);
      } else {
        dec.skipBareValue();
      }
    }
  }

  // Clausewitz.extractWarFields expects start_date/end_date/joined.date/
  // left.date to already be "Y.M.D" strings (true for the text parser's
  // output) - the binary decoder hands back raw hour counts instead (same
  // encoding as metadata.date), so convert the handful of date fields in
  // place before handing the object to the shared extractor. Mirrors
  // extractBlackDeathBinary's date handling for situation_manager.
  function convertWarDatesBinary(warObj) {
    if (typeof warObj.start_date === "number") warObj.start_date = dateFromHours(warObj.start_date);
    if (typeof warObj.end_date === "number") warObj.end_date = dateFromHours(warObj.end_date);
    const all = Array.isArray(warObj.all) ? warObj.all : warObj.all ? [warObj.all] : [];
    for (const p of all) {
      if (!p || typeof p !== "object") continue;
      const histories = [];
      if (Array.isArray(p.history)) histories.push(...p.history.filter((h) => h && typeof h === "object"));
      else if (p.history && typeof p.history === "object") histories.push(p.history);
      const aliased = p["#3db9"];
      if (Array.isArray(aliased)) histories.push(...aliased.filter((h) => h && typeof h === "object"));
      else if (aliased && typeof aliased === "object") histories.push(aliased);
      for (const history of histories) {
        const joined = history.joined;
        if (joined && typeof joined.date === "number") joined.date = dateFromHours(joined.date);
        const left = history.left;
        if (left && typeof left.date === "number") left.date = dateFromHours(left.date);
      }
    }
    return warObj;
  }

  // Mirrors js/clausewitz.js's parseWarManagerSection: "names" (naming
  // templates) is skipped, each "database" entry is fully decoded then
  // immediately reduced via Clausewitz.extractWarFields and discarded.
  function parseWarManagerSection(dec, view, onWar) {
    dec.pos += 2; // consume OPEN already peeked by caller
    while (true) {
      const peek = view.getUint16(dec.pos, true);
      if (peek === CLOSE) {
        dec.pos += 2;
        break;
      }
      const resolved = dec.resolveToken();
      const key = dec.keyToPropName(resolved);
      const eq = view.getUint16(dec.pos, true);
      if (eq !== EQUALS) throw new Error(`war_manager desync at ${dec.pos}`);
      dec.pos += 2;

      if (key === "database") {
        const openCode = view.getUint16(dec.pos, true);
        dec.pos += 2;
        if (openCode !== OPEN) throw new Error("expected war_manager.database to be a subobject");
        while (true) {
          const p2 = view.getUint16(dec.pos, true);
          if (p2 === CLOSE) {
            dec.pos += 2;
            break;
          }
          const numResolved = dec.resolveToken();
          const eq2 = view.getUint16(dec.pos, true);
          if (eq2 !== EQUALS) throw new Error(`war_manager.database desync at ${dec.pos}`);
          dec.pos += 2;
          const warObj = dec.readBareValue();
          // Freed/reserved war IDs decode to a bare unresolved value (the
          // literal "none" in melted text) rather than a subobject - same
          // tombstone-entry shape as countries.database's phantom
          // (merged-away) entries. extractWarFields already returns null
          // for a non-object, so this filters them the same way.
          if (warObj && typeof warObj === "object" && !Array.isArray(warObj) && !("fixedNum" in warObj)) {
            const war = Clausewitz.extractWarFields(numResolved, convertWarDatesBinary(warObj));
            if (war) onWar(war);
          }
        }
      } else {
        dec.skipBareValue();
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

  async function parseCompressedSave(arrayBuffer, options) {
    options = options || {};
    const onProgress = options.onProgress || function () {};
    const bytes = new Uint8Array(arrayBuffer);

    const headerText = utf8Decode(new DataView(bytes.buffer, bytes.byteOffset, Math.min(64, bytes.length)), 0, Math.min(64, bytes.length));
    const nl = headerText.indexOf("\n");
    if (nl === -1 || !headerText.startsWith("SAV")) throw new Error("not an EU5 save file");
    const bodyStart = nl + 1;

    // Find the embedded zip's start.
    let zipStart = -1;
    for (let i = bodyStart; i < bytes.length - 4; i++) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x03 && bytes[i + 3] === 0x04) {
        zipStart = i;
        break;
      }
    }
    if (zipStart === -1) throw new Error("could not find embedded zip in save file");

    const metadataBytes = bytes.subarray(bodyStart, zipStart);
    onProgress(0.1);

    const zipBytes = bytes.subarray(zipStart);
    const entries = await extractZipEntries(zipBytes, ["gamestate", "string_lookup"]);
    onProgress(0.4);

    const strings = parseStringLookup(entries.string_lookup);
    onProgress(0.5);

    const metadata = parseMetadataBlock(metadataBytes, strings);
    onProgress(0.55);

    const gsView = new DataView(entries.gamestate.buffer, entries.gamestate.byteOffset, entries.gamestate.byteLength);
    const includeLocations = !!options.includeLocations;
    // war_manager.database entries carry a big per-battle combat log each -
    // opt-in for the same reason as includeLocations, independent of it
    // (see js/clausewitz.js's parseSave for the text-format twin).
    const includeWars = !!options.includeWars;
    const result = {
      metadata,
      countries: [],
      countriesByNumber: new Map(),
      players: [],
      playerSessions: [],
      locations: [],
      dependencies: [],
      locationAssets: [],
      cultures: [],
      religions: [],
      markets: [],
      wars: [],
      blackDeath: { status: null, start: null, end: null, identity: null, deathsByCountry: null },
      provinceOwnerByDefinition: {},
    };

    // Normally "countries" and "played_country" are true top-level keys, but
    // at least one observed save (an early-patch autosave) nested them one
    // level deeper than expected and never closed the wrapping section - a
    // likely truncated/interrupted write rather than a format change, but we
    // can't assume that in general. Recognizing these keys wherever they
    // appear (via onSpecialKey, checked at every depth in skipBody, not just
    // here at the outer loop) means we still extract them either way.
    // Fixed IDs aren't guaranteed globally unique (a 16-bit space shared
    // across a huge schema can collide), so a bare key match isn't proof
    // enough once we're checking at every nesting depth instead of just the
    // true top level - validate the shape before committing, and fall back
    // to a normal skip on mismatch.
    let countriesSeen = false;
    let locationsSeen = false;
    let diplomacySeen = false;
    let estateManagerSeen = false;
    let cultureManagerSeen = false;
    let religionManagerSeen = false;
    let marketManagerSeen = false;
    let situationManagerSeen = false;
    let warManagerSeen = false;
    let diseaseOutbreakManagerSeen = false;
    let provincesSeen = false;
    function handleSpecialKey(key) {
      if (key === "countries" && !countriesSeen) {
        const beforePos = dec.pos;
        const peek = gsView.getUint16(dec.pos, true);
        if (peek !== OPEN) return false;
        const afterOpen = dec.pos + 2;
        dec.pos = afterOpen;
        const firstKey = dec.keyToPropName(dec.resolveToken());
        dec.pos = beforePos; // rewind; parseCountriesSection expects to see OPEN itself
        if (firstKey !== "tags") return false;
        countriesSeen = true;
        parseCountriesSection(dec, gsView, (country) => {
          result.countries.push(country);
          result.countriesByNumber.set(country.number, country);
        });
        return true;
      }
      if (key === "played_country") {
        const obj = dec.readBareValue();
        // Handled either way (value's already consumed) - a shape mismatch
        // just means we discard it, not that skipBody should re-walk it.
        if (obj && typeof obj === "object" && !Array.isArray(obj) && typeof obj.name === "string" && typeof obj.country === "number") {
          result.players.push(extractPlayer(obj));
        }
        return true;
      }
      if (key === "locations" && includeLocations && !locationsSeen) {
        const beforePos = dec.pos;
        const peek = gsView.getUint16(dec.pos, true);
        if (peek !== OPEN) return false;
        const afterOpen = dec.pos + 2;
        dec.pos = afterOpen;
        const firstKey = dec.keyToPropName(dec.resolveToken());
        dec.pos = beforePos;
        if (firstKey !== "locations") return false;
        locationsSeen = true;
        parseLocationsSection(dec, gsView, (location) => {
          result.locations.push(location);
        });
        return true;
      }
      // dependencies are small (hundreds of entries) - always parsed, no
      // includeLocations-style opt-in needed.
      if (key === "diplomacy_manager" && !diplomacySeen) {
        const peek = gsView.getUint16(dec.pos, true);
        if (peek !== OPEN) return false;
        diplomacySeen = true;
        parseDiplomacyManagerSection(dec, gsView, (dep) => {
          result.dependencies.push(dep);
        });
        return true;
      }
      if (key === "estate_manager" && includeLocations && !estateManagerSeen) {
        const beforePos = dec.pos;
        const peek = gsView.getUint16(dec.pos, true);
        if (peek !== OPEN) return false;
        const afterOpen = dec.pos + 2;
        dec.pos = afterOpen;
        const firstKey = dec.keyToPropName(dec.resolveToken());
        dec.pos = beforePos;
        if (firstKey !== "database") return false;
        estateManagerSeen = true;
        parseEstateManagerSection(dec, gsView, (asset) => {
          result.locationAssets.push(asset);
        });
        return true;
      }
      if ((key === "culture_manager" || key === "religion_manager") && includeLocations) {
        if (key === "culture_manager" && cultureManagerSeen) return false;
        if (key === "religion_manager" && religionManagerSeen) return false;
        const beforePos = dec.pos;
        const peek = gsView.getUint16(dec.pos, true);
        if (peek !== OPEN) return false;
        const afterOpen = dec.pos + 2;
        dec.pos = afterOpen;
        const firstKey = dec.keyToPropName(dec.resolveToken());
        dec.pos = beforePos;
        if (firstKey !== "database") return false;
        if (key === "culture_manager") {
          cultureManagerSeen = true;
          parseNamedDatabaseSection(dec, gsView, key, (entry) => result.cultures.push(entry));
        } else {
          religionManagerSeen = true;
          parseNamedDatabaseSection(dec, gsView, key, (entry) => result.religions.push(entry));
        }
        return true;
      }
      if (key === "market_manager" && includeLocations && !marketManagerSeen) {
        const beforePos = dec.pos;
        const peek = gsView.getUint16(dec.pos, true);
        if (peek !== OPEN) return false;
        const afterOpen = dec.pos + 2;
        dec.pos = afterOpen;
        const firstKey = dec.keyToPropName(dec.resolveToken());
        dec.pos = beforePos;
        if (firstKey !== "database" && firstKey !== "#324d") return false;
        marketManagerSeen = true;
        parseMarketManagerSection(dec, gsView, (entry) => result.markets.push(entry));
        return true;
      }
      if (key === "provinces" && includeLocations && !provincesSeen) {
        const beforePos = dec.pos;
        const peek = gsView.getUint16(dec.pos, true);
        if (peek !== OPEN) return false;
        const afterOpen = dec.pos + 2;
        dec.pos = afterOpen;
        const firstKey = dec.keyToPropName(dec.resolveToken());
        dec.pos = beforePos;
        if (firstKey !== "database") return false;
        provincesSeen = true;
        parseProvincesSection(dec, gsView, (p) => {
          result.provinceOwnerByDefinition[p.definition] = p.owner;
        });
        return true;
      }
      if (key === "situation_manager" && !situationManagerSeen) {
        const beforePos = dec.pos;
        const peek = gsView.getUint16(dec.pos, true);
        if (peek !== OPEN) return false;
        const afterOpen = dec.pos + 2;
        dec.pos = afterOpen;
        const firstKey = dec.keyToPropName(dec.resolveToken());
        dec.pos = beforePos;
        if (firstKey !== "black_death") return false;
        situationManagerSeen = true;
        parseSituationManagerSection(dec, gsView, (obj) => {
          result.blackDeath = extractBlackDeathBinary(obj);
        });
        return true;
      }
      // Only walk this (potentially very large) section once we actually
      // know which outbreak identity to look for - situation_manager always
      // appears earlier in the file, so result.blackDeath.identity is
      // already set by the time we get here if the Black Death has started
      // this campaign. Otherwise fall through to a normal skip, same cost
      // as any other unhandled key.
      if (key === "disease_outbreak_manager" && !diseaseOutbreakManagerSeen && typeof result.blackDeath.identity === "number") {
        const beforePos = dec.pos;
        const peek = gsView.getUint16(dec.pos, true);
        if (peek !== OPEN) return false;
        const afterOpen = dec.pos + 2;
        dec.pos = afterOpen;
        const firstKey = dec.keyToPropName(dec.resolveToken());
        dec.pos = beforePos;
        if (firstKey !== "database") return false;
        diseaseOutbreakManagerSeen = true;
        result.blackDeath.deathsByCountry = parseDiseaseOutbreakManagerSection(dec, gsView, result.blackDeath.identity);
        return true;
      }
      if (key === "war_manager" && includeWars && !warManagerSeen) {
        const beforePos = dec.pos;
        const peek = gsView.getUint16(dec.pos, true);
        if (peek !== OPEN) return false;
        const afterOpen = dec.pos + 2;
        dec.pos = afterOpen;
        const firstKey = dec.keyToPropName(dec.resolveToken());
        dec.pos = beforePos;
        // Pre-1.3 saves omit the "names" naming-template block entirely and
        // go straight to "database" - accept either shape (same pattern as
        // market_manager's two acceptable first keys above).
        if (firstKey !== "names" && firstKey !== "database") return false;
        warManagerSeen = true;
        parseWarManagerSection(dec, gsView, (war) => {
          result.wars.push(war);
        });
        return true;
      }
      return false;
    }

    const dec = makeDecoder(gsView, strings, { onSpecialKey: handleSpecialKey });
    const total = entries.gamestate.length;
    let lastProgressPos = 0;
    const progressStep = Math.max(1, Math.floor(total / 100));

    try {
      while (dec.pos < total) {
        const resolved = dec.resolveToken();
        const key = dec.keyToPropName(resolved);
        const eq = gsView.getUint16(dec.pos, true);
        if (eq !== EQUALS) break; // malformed/truncated tail - stop, keep what we have
        dec.pos += 2;

        if (!handleSpecialKey(key)) {
          dec.skipBareValue();
        }

        if (dec.pos - lastProgressPos > progressStep) {
          lastProgressPos = dec.pos;
          onProgress(0.55 + 0.45 * (dec.pos / total));
        }
      }
    } catch (err) {
      // Truncated save, or a structural quirk we haven't seen - keep
      // whatever countries/players were successfully extracted rather than
      // losing everything to one bad section.
      if (typeof console !== "undefined" && console.warn) {
        console.warn("EU5 save parsing stopped early (partial results kept):", err.message);
      }
    }

    // See js/clausewitz.js's collapsePlayerSessions for why "last entry per
    // country wins, then dedupe by player name across countries too" (no
    // explicit timestamp on these, but file order reflects recency) - shared
    // logic, not duplicated here.
    Clausewitz.collapsePlayerSessions(result);
    Clausewitz.attachLocationAssets(result);

    onProgress(1);
    return result;
  }

  return { parseCompressedSave, parseStringLookup, extractZipEntries, makeDecoder, parseMetadataBlock };
});
