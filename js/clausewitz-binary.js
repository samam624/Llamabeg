// Parser for EU5's compressed (binary-tokenized) save format. Produces the
// same result shape as js/clausewitz.js's parseSave() for melted text saves,
// so the rest of the app doesn't need to care which format was uploaded.
//
// Streaming decoder (originally a two-phase "tape" matching github.com/
// rakaly/jomini, the Rust parser PDX Tools is built on; rearchitected again
// 2026-08-12 onto on-demand streaming - see makeDecoder's own comment for
// why). The property that actually matters, preserved across both designs:
//   Width is ALWAYS determined purely by a token's own 2-byte type tag -
//   never by "what section/key is this", so a shape assumption being wrong
//   can never lose byte alignment for everything downstream. That was the
//   actual root cause of two real bugs found in one real save the night
//   this was first built (a bare/unkeyed top-level array the old single-
//   pass walker didn't expect, and two real value-type codes - I64 0x0317,
//   F32 0x000d - that had no width handling at all and silently
//   under-consumed their payload). See CHANGELOG.
//   The section-specific extractors (parseCountriesSection etc.) walk
//   forward through the decoded tokens by INDEX, not by byte offset. Every
//   index is guaranteed to land on a real token boundary by construction,
//   so a mistaken shape assumption in a section extractor can at worst
//   misread ONE section's meaning - it can never again corrupt byte
//   alignment for everything downstream.
//
// Format (reverse-engineered against real saves, cross-checked field by
// field against melted plaintext - see test/run-binary.js, which validates
// this module's output against js/clausewitz.js's text parser):
//   "SAV02" + "00"(text) | "03"(binary) + ... + "\n"
//   [binary metadata block, same encoding as gamestate]
//   [zip: "gamestate" entry (deflate), "string_lookup" entry (deflate)]
//
// Token grammar inside metadata/gamestate (all integers little-endian) -
// cross-checked complete against jomini's binary token catalog:
//   0x0003 / 0x0004        object/array open / close
//   0x0001                 "=" (only appears between a key and its value)
//   0x000e                 bool, 1 byte (00/01)
//   0x000c/0x0014           int32, 4 bytes
//   0x029c                  u64, 8 bytes
//   0x0317                  i64, 8 bytes
//   0x000d                  f32, 4 bytes
//   0x000f/0x0017          Hollerith string (2-byte length + utf8 bytes)
//   0x0167                 fixed-point, 8 bytes / 100000
//   0x0d40 / 0x0d43        string_lookup ref, 1-byte index (0x0d43 seen on
//                          pre-1.3 saves only, e.g. top-level manager keys)
//   0x0d3e / 0x0d44        string_lookup ref, 2-byte index (value / name use)
//   0x0d41 / 0x0d3f        string_lookup ref, 3-byte / 4-byte index (needed
//                          once string_lookup exceeds 65536 entries - a
//                          long multiplayer campaign's easily does)
//   0x0d42                 empty string, 0 bytes
//   0x0d48-0x0d4e          fixed-point, 1-7 bytes / 100000 (positive)
//   0x0d4f-0x0d56          fixed-point, 1-7 bytes / 100000 (negated)
//   0x0243                 RGB color tag - zero payload of its own; the
//                          OPEN+3 numbers+CLOSE that follow are just more
//                          ordinary tokens, composed into a color by phase 2
//   anything else          a fixed ID: either a well-known key (see
//                          eu5-fixed-ids.js) or, in value position, an
//                          opaque enum-like identifier we don't resolve -
//                          zero payload bytes of its own, by construction
//                          (every real value-type code above already
//                          claimed its own width first).
// A key can ALSO be an int32-coded token (used for numeric map keys like
// countries.database's country numbers) or a string_lookup ref (used for
// keys that aren't common enough to deserve a fixed ID, e.g. top-level
// manager names). Every "key candidate" is resolved the same way regardless
// of position, then whatever follows determines whether it's a key (EQUALS
// follows) or a bare array element (it doesn't) - true at every nesting
// depth, INCLUDING the true top level of gamestate (a real save was found
// with a long run of bare top-level records; see the top-level loop below).
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./eu5-fixed-ids.js"), require("./clausewitz.js"));
  } else {
    root.ClausewitzBinary = factory(root.EU5FixedIds, root.Clausewitz);
  }
})(typeof self !== "undefined" ? self : this, function (EU5FixedIds, Clausewitz) {
  "use strict";

  const STRREF8 = 0x0d40;
  const STRREF8_ALT = 0x0d43;
  const STRREF16 = 0x0d3e;
  const STRREF16_NAME = 0x0d44;
  const STRREF24 = 0x0d41;
  const STRREF32 = 0x0d3f;
  const EMPTY_STRING = 0x0d42;
  const FIXED_POINT_ZERO = 0x0d47;
  const OPEN = 0x0003;
  const CLOSE = 0x0004;
  const EQUALS = 0x0001;

  // --- Streaming decoder: tokenize AND walk in one pass, on demand -------

  const TAPE_OPEN = 1;
  const TAPE_CLOSE = 2;
  const TAPE_EQUALS = 3;
  const TAPE_NUMBER = 4;
  const TAPE_BOOL = 5;
  const TAPE_STRING = 6;
  const TAPE_TOKEN = 7; // opaque fixed-ID, no payload of its own
  const TAPE_RGB_TAG = 8;

  function utf8Decode(dataView, offset, len) {
    const bytes = new Uint8Array(dataView.buffer, dataView.byteOffset + offset, len);
    if (typeof TextDecoder !== "undefined") {
      return new TextDecoder("utf-8").decode(bytes);
    }
    return Buffer.from(bytes).toString("utf8"); // Node fallback
  }

  // 2026-08-12: rearchitected from a two-phase design (tokenize the WHOLE
  // file into a flat in-memory array first, then walk that array by index)
  // onto true on-demand streaming - no materialized representation of the
  // file's tokens exists at all now, just this cursor's own O(1) state.
  // This is the actual root cause fix behind repeated real OOM crashes: the
  // old tape's per-entry arrays (even after an earlier same-day pass moved
  // them onto typed arrays instead of a boxed heterogeneous array) still
  // cost memory proportional to the WHOLE file's token count - measured at
  // 3.1GB peak RSS for one real 77MB save even after that first fix. A
  // "simple background save-tracker" has no business needing gigabytes of
  // RAM, and every prior fix in this file's history (worker heap ceilings,
  // concurrency caps, memory-reserve constants) was managing around that
  // cost instead of removing it.
  //
  // This works because of something already true about how phase 2 ever
  // consumed the tape: every walker (decodeBody/skipBody in this file) only
  // ever moves FORWARD, one token at a time, with at most a tiny bounded
  // "peek a token, and un-peek it if it turns out not to be a key" lookback
  // (confirmed by inspection: `matches`, the tape's OWN matching-bracket-
  // index array from the prior architecture, was NEVER READ anywhere in
  // this codebase - real, unnecessary dead weight, not a leftover this
  // rewrite needs to preserve). Nothing here ever needed true random
  // access. `makeDecoder()` below decodes exactly one token at a time
  // directly from the raw byte view and hands it to the caller; the only
  // state it keeps between tokens is a small fixed-size ring buffer (16
  // entries) recording each of the last few tokens' byte start position,
  // which is all the ".pos = someEarlierPos" rewind pattern above ever
  // actually needs (verified: the deepest real rewind in this file is ~6
  // tokens, for the one case - a bare RGB color value - where resolving a
  // token can itself consume several more before the caller discovers it
  // needs to back up and re-read differently). A rewind past what the ring
  // retains throws loudly instead of silently reading the wrong bytes -
  // this parser has a real history of subtle correctness bugs from changes
  // just like this one, so an unexpected access pattern should fail fast in
  // testing, not corrupt data quietly in production.
  //
  // Width is still ALWAYS self-describing purely from a token's own 2-byte
  // type code, exactly as before - that correctness property (the actual
  // point of the 2026-07-23 tape rewrite, which this doesn't undo) is
  // unchanged; only the STORAGE between decoding a token and consuming it
  // changed, from "keep every one forever in an array" to "keep the current
  // one, plus a short recent history for the rare rewind."
  function makeDecoder(view, strings, opts) {
    const total = view.byteLength;
    const onSpecialKey = opts && opts.onSpecialKey;
    const onProgress = opts && opts.onProgress;
    const debugRing = opts && opts.debug ? [] : null;
    const DEBUG_RING_SIZE = 80;
    const progressStep = Math.max(1, Math.floor(total / 200));
    let lastProgressPos = 0;
    let truncated = false;

    function debugRecord(entry) {
      if (!debugRing) return;
      debugRing.push(entry);
      if (debugRing.length > DEBUG_RING_SIZE) debugRing.shift();
    }
    function lookupStr(idx) {
      return strings && strings[idx] !== undefined ? strings[idx] : `#strref:${idx}`;
    }

    // Decodes exactly one token starting at byte `p`. Returns
    // {kind, start, next, numVal, strVal} (numVal/strVal populated per kind,
    // matching tokenize()'s old per-kind split), or null at EOF/on a read
    // that would run past the buffer (also sets `truncated`).
    function decodeOneAt(p) {
      if (p >= total) return null;
      const start = p;
      try {
        const code = view.getUint16(p, true);
        p += 2;
        if (code === OPEN) return { kind: TAPE_OPEN, start, next: p };
        if (code === CLOSE) return { kind: TAPE_CLOSE, start, next: p };
        if (code === EQUALS) return { kind: TAPE_EQUALS, start, next: p };
        if (code === STRREF8 || code === STRREF8_ALT) {
          const idx = view.getUint8(p);
          p += 1;
          return { kind: TAPE_STRING, start, next: p, strVal: lookupStr(idx) };
        }
        if (code === STRREF16 || code === STRREF16_NAME) {
          const idx = view.getUint16(p, true);
          p += 2;
          return { kind: TAPE_STRING, start, next: p, strVal: lookupStr(idx) };
        }
        if (code === STRREF24) {
          const idx = view.getUint8(p) + (view.getUint8(p + 1) << 8) + (view.getUint8(p + 2) << 16);
          p += 3;
          return { kind: TAPE_STRING, start, next: p, strVal: lookupStr(idx) };
        }
        if (code === STRREF32) {
          const idx = view.getUint32(p, true);
          p += 4;
          return { kind: TAPE_STRING, start, next: p, strVal: lookupStr(idx) };
        }
        if (code === EMPTY_STRING) return { kind: TAPE_STRING, start, next: p, strVal: "" };
        if (code === 0x000e) {
          const v = view.getUint8(p);
          p += 1;
          return { kind: TAPE_BOOL, start, next: p, numVal: v === 1 ? 1 : 0 };
        }
        if (code === 0x000c || code === 0x0014) {
          const v = view.getInt32(p, true);
          p += 4;
          return { kind: TAPE_NUMBER, start, next: p, numVal: v };
        }
        if (code === 0x029c || code === 0x0317) {
          // U64 / I64 - both real 8-byte codes (jomini's catalog,
          // github.com/rakaly/jomini) - see the module comment's token
          // grammar table for the full width reference.
          const lo = view.getUint32(p, true);
          const hi = view.getInt32(p + 4, true);
          p += 8;
          return { kind: TAPE_NUMBER, start, next: p, numVal: hi * 4294967296 + lo };
        }
        if (code === 0x000d) {
          const v = view.getFloat32(p, true);
          p += 4;
          return { kind: TAPE_NUMBER, start, next: p, numVal: v };
        }
        if (code === 0x000f || code === 0x0017) {
          const len = view.getUint16(p, true);
          p += 2;
          const s = utf8Decode(view, p, len);
          p += len;
          return { kind: TAPE_STRING, start, next: p, strVal: s };
        }
        if (code === 0x0167) {
          const lo = view.getUint32(p, true);
          const hi = view.getInt32(p + 4, true);
          p += 8;
          return { kind: TAPE_NUMBER, start, next: p, numVal: (hi * 4294967296 + lo) / 100000.0 };
        }
        if (code === FIXED_POINT_ZERO) return { kind: TAPE_NUMBER, start, next: p, numVal: 0 };
        if (code >= 0x0d48 && code <= 0x0d4e) {
          const n = code - 0x0d48 + 1;
          let v = 0;
          for (let i = n - 1; i >= 0; i--) v = v * 256 + view.getUint8(p + i);
          p += n;
          return { kind: TAPE_NUMBER, start, next: p, numVal: v / 100000.0 };
        }
        if (code >= 0x0d4f && code <= 0x0d56) {
          const n = code - 0x0d4f + 1;
          let v = 0;
          for (let i = n - 1; i >= 0; i--) v = v * 256 + view.getUint8(p + i);
          p += n;
          return { kind: TAPE_NUMBER, start, next: p, numVal: -v / 100000.0 };
        }
        if (code === 0x0243) {
          // Zero payload of its own - the OPEN+3 numbers+CLOSE that follow
          // decode completely normally as the next tokens; resolveToken()
          // below composes them into a color.
          return { kind: TAPE_RGB_TAG, start, next: p };
        }
        // Opaque fixed-ID: a well-known key (resolved later via
        // EU5FixedIds) or an enum-like value we don't further decode.
        // Reached only once every real value-type code above has already
        // claimed its own width - not a guess.
        return { kind: TAPE_TOKEN, start, next: p, numVal: code };
      } catch (err) {
        truncated = true;
        return null;
      }
    }

    // Fixed-size lookback so the bounded "peek then un-peek" pattern used
    // by decodeBody/skipBody/peekFirstKeyOfObject can rewind without
    // keeping the whole file's tokens around - see the module comment
    // above for why 16 is comfortably above every real rewind distance in
    // this file.
    const RING_SIZE = 16;
    const ring = new Array(RING_SIZE);
    let tokenIndex = -1; // index of the current (already-decoded, not yet advanced-past) token
    let bytePos = 0;
    let curKind, curNumVal, curStrVal, curStart, curNext;
    let curDecoded = false;

    function ensureCurrent() {
      if (curDecoded) return;
      const t = decodeOneAt(bytePos);
      if (!t) {
        curKind = undefined;
        curDecoded = true;
        return;
      }
      curKind = t.kind;
      curNumVal = t.numVal;
      curStrVal = t.strVal;
      curStart = t.start;
      curNext = t.next;
      curDecoded = true;
      tokenIndex++;
      ring[tokenIndex % RING_SIZE] = { tokenIndex, byteStart: curStart };
      if (onProgress && curNext - lastProgressPos > progressStep) {
        lastProgressPos = curNext;
        onProgress(curNext / total);
      }
    }

    function advance() {
      ensureCurrent();
      if (curKind === undefined) return;
      bytePos = curNext;
      curDecoded = false;
    }

    function peekKind() {
      ensureCurrent();
      return curKind;
    }

    function currentByteOffset() {
      ensureCurrent();
      return curKind !== undefined ? curStart : bytePos;
    }

    function getPos() {
      ensureCurrent();
      return tokenIndex;
    }

    function setPos(v) {
      if (curDecoded && v === tokenIndex + 1) {
        advance();
        return;
      }
      const entry = ring[((v % RING_SIZE) + RING_SIZE) % RING_SIZE];
      if (!entry || entry.tokenIndex !== v) {
        throw new Error(`streaming cursor cannot rewind to tape index ${v} (current ${tokenIndex}, retains the last ${RING_SIZE}) - an access pattern this decoder wasn't designed for`);
      }
      bytePos = entry.byteStart;
      tokenIndex = v - 1;
      curDecoded = false;
    }

    // Resolves the current token to a string/number/bool, an RGB object, or
    // a fixed-ID key name / "#hex" placeholder, decoding it fresh if it
    // hasn't been peeked yet. Advances past the whole token (and, for RGB,
    // the container that follows it) either way.
    function resolveToken() {
      ensureCurrent();
      const kind = curKind;
      const val = kind === TAPE_STRING ? curStrVal : kind === TAPE_BOOL ? curNumVal === 1 : curNumVal;
      advance();
      if (kind === TAPE_STRING || kind === TAPE_NUMBER || kind === TAPE_BOOL) return val;
      if (kind === TAPE_RGB_TAG) {
        if (peekKind() !== TAPE_OPEN) throw new Error(`expected OPEN after COLOR_RGB at byte ${currentByteOffset()}`);
        advance();
        return { colorSpace: "rgb", values: decodeBody() };
      }
      if (kind === TAPE_TOKEN) {
        const knownName = EU5FixedIds[val.toString(16)];
        if (knownName) return knownName;
        return { fixedNum: val };
      }
      // 0x0001/0x0003/0x0004 (EQUALS/OPEN/CLOSE) are heavily overloaded:
      // they're structural control codes ONLY when a caller explicitly
      // checks for them (peekKind() === TAPE_EQUALS right after a resolved
      // key; peekKind() === TAPE_OPEN/TAPE_CLOSE before ever calling
      // resolveToken() at all) - every such call site does exactly that,
      // never reaching here for it. But the raw format also reuses those
      // same 2-byte codes as bare opaque values in their own right.
      // Byte-verified on two different real saves: population.database's
      // per-pop "pop_demand" field decodes to a bare array whose middle
      // element is a literal EQUALS-coded token with no key before it, and
      // a played_country-adjacent field elsewhere decodes to a literal
      // CLOSE-coded token the same way - neither is a syntax error, just
      // an ordinary unmapped fixed-ID that happens to numerically collide
      // with a control code, reached only via readBareValue()/decodeBody()'s
      // bare-item fallback, which no key=value or container check applies
      // to. Matches the exact fallback every other unmapped code already
      // gets - the old (pre-tape) architecture never special-cased ANY of
      // these three when reached this way either.
      if (kind === TAPE_EQUALS) return { fixedNum: 1 };
      if (kind === TAPE_OPEN) return { fixedNum: 3 };
      if (kind === TAPE_CLOSE) return { fixedNum: 4 };
      // Reached when the stream ends (kind undefined) mid-section, or any
      // other genuinely unexpected state - the caller's own try/catch (see
      // parseCompressedSave) turns this into a flagged parseWarning rather
      // than silently returning incomplete data as if it were complete.
      throw new Error(`unexpected end of gamestate (kind ${kind}) in value position at byte ${currentByteOffset()}`);
    }

    function keyToPropName(resolved) {
      if (typeof resolved === "string" || typeof resolved === "number") return resolved;
      if (typeof resolved !== "object" || resolved === null || typeof resolved.fixedNum !== "number") {
        return "#unexpected:" + JSON.stringify(resolved);
      }
      const hex = resolved.fixedNum.toString(16);
      return EU5FixedIds[hex] || "#" + hex;
    }

    function addEntry(obj, key, val) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        if (Array.isArray(obj[key])) obj[key].push(val);
        else obj[key] = [obj[key], val];
      } else {
        obj[key] = val;
      }
    }

    function readBareValue() {
      if (peekKind() === TAPE_OPEN) {
        advance();
        return decodeBody();
      }
      return resolveToken();
    }

    function skipBareValue() {
      const kind = peekKind();
      if (kind === TAPE_OPEN) {
        advance();
        skipBody();
        return;
      }
      if (kind === TAPE_RGB_TAG) {
        advance();
        if (peekKind() !== TAPE_OPEN) throw new Error(`expected OPEN after COLOR_RGB at byte ${currentByteOffset()}`);
        advance();
        skipBody();
        return;
      }
      advance();
    }

    function decodeBody() {
      const items = [];
      const named = {};
      let hasNamed = false;
      while (true) {
        const kind = peekKind();
        if (kind === TAPE_CLOSE) {
          advance();
          break;
        }
        if (kind === TAPE_OPEN) {
          advance();
          items.push(decodeBody());
          continue;
        }
        const savedPos = getPos();
        const resolved = resolveToken();
        if (peekKind() === TAPE_EQUALS) {
          advance();
          const value = readBareValue();
          addEntry(named, keyToPropName(resolved), value);
          hasNamed = true;
        } else if (typeof resolved !== "object") {
          items.push(resolved);
        } else {
          setPos(savedPos);
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
        const tokenStart = getPos();
        const kind = peekKind();
        if (kind === TAPE_CLOSE) {
          advance();
          debugRecord({ pos: tokenStart, depth, type: "CLOSE" });
          return;
        }
        if (kind === TAPE_OPEN) {
          advance();
          debugRecord({ pos: tokenStart, depth, type: "OPEN" });
          skipBody(depth + 1);
          continue;
        }
        const savedPos = getPos();
        const resolved = resolveToken();
        if (peekKind() === TAPE_EQUALS) {
          advance();
          const keyName = keyToPropName(resolved);
          debugRecord({ pos: tokenStart, depth, type: "KEY", key: keyName });
          if (!onSpecialKey || !onSpecialKey(keyName)) {
            skipBareValue();
          }
        } else if (typeof resolved !== "object") {
          debugRecord({ pos: tokenStart, depth, type: "BAREVALUE", value: resolved });
        } else {
          setPos(savedPos);
          debugRecord({ pos: tokenStart, depth, type: "BAREVALUE_FIXEDID", fixedNum: resolved.fixedNum });
          skipBareValue();
        }
      }
    }

    return {
      get pos() {
        return getPos();
      },
      set pos(v) {
        setPos(v);
      },
      get byteOffset() {
        return currentByteOffset();
      },
      get truncated() {
        return truncated;
      },
      peekKind,
      getDebugRing() {
        return debugRing ? debugRing.slice() : [];
      },
      getDebugAnomalies() {
        return []; // structurally obsolete - see module comment
      },
      resolveToken,
      readBareValue,
      skipBareValue,
      decodeBody,
      skipBody,
      keyToPropName,
    };
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
    dec.resolveToken(); // "id" token - unused, matches the original's blind skip
    if (dec.peekKind() !== TAPE_EQUALS) throw new Error("expected EQUALS after metadata id");
    dec.pos += 1;
    if (dec.peekKind() !== TAPE_OPEN) throw new Error("expected metadata value to be a subobject");
    dec.pos += 1;
    const metadata = dec.decodeBody();
    if (typeof metadata.date === "number") metadata.date = dateFromHours(metadata.date);
    return metadata;
  }

  // Generic walker for "<section>={ key=value key=value ... }". The caller
  // has already peeked TAPE_OPEN; this consumes it, then calls onKey(key)
  // for each entry - true if onKey fully handled (and consumed) the value
  // itself, false to skip it generically. Used directly by
  // parseDiplomacyManagerSection (two named keys of interest at this level)
  // and as the outer loop for every "...database={n={...}}" shaped section.
  function walkSection(dec, onKey) {
    dec.pos += 1; // consume OPEN already peeked by caller
    while (true) {
      if (dec.peekKind() === TAPE_CLOSE) {
        dec.pos += 1;
        break;
      }
      const resolved = dec.resolveToken();
      const key = dec.keyToPropName(resolved);
      if (dec.peekKind() !== TAPE_EQUALS) throw new Error(`section desync at tape index ${dec.pos} (byte ${dec.byteOffset})`);
      dec.pos += 1;
      if (!onKey(key)) dec.skipBareValue();
    }
  }

  // Generic walker for the "database={ <n>={...} <n>={...} ... }" numbered-
  // entry shape shared by countries/locations/estate_manager/building_
  // manager/market_manager/provinces/war_manager/loan_manager/culture_
  // manager/religion_manager/international_organization_manager/character_
  // db/work_of_art_manager/population/subunit_manager/trade_path_manager/
  // trade_manager. Caller has already consumed the "database=" key and
  // peeked its value is TAPE_OPEN. Filters out tombstone/placeholder
  // entries (a merged-away country, a freed war ID, a cleared loan - all
  // encoded as a bare unresolved token rather than a real object) before
  // calling onEntry(number, obj) - the identical filter every section had.
  function walkDatabase(dec, onEntry) {
    dec.pos += 1; // consume OPEN already peeked/verified by caller
    while (true) {
      if (dec.peekKind() === TAPE_CLOSE) {
        dec.pos += 1;
        break;
      }
      const numResolved = dec.resolveToken();
      if (dec.peekKind() !== TAPE_EQUALS) throw new Error(`database desync at tape index ${dec.pos} (byte ${dec.byteOffset})`);
      dec.pos += 1;
      const obj = dec.readBareValue();
      if (obj && typeof obj === "object" && !Array.isArray(obj) && !("fixedNum" in obj)) {
        onEntry(numResolved, obj);
      }
    }
  }

  // Peeks the first key of the object at dec.pos WITHOUT consuming
  // anything - used throughout handleSpecialKey to confirm an ambiguous
  // top-level key (fixed IDs aren't guaranteed globally unique) really is
  // the section it looks like before committing to a specialized parser.
  // Returns null if dec.pos isn't positioned at an object at all.
  function peekFirstKeyOfObject(dec) {
    const before = dec.pos;
    if (dec.peekKind() !== TAPE_OPEN) return null;
    dec.pos += 1;
    const firstKey = dec.keyToPropName(dec.resolveToken());
    dec.pos = before;
    return firstKey;
  }

  function parseCountriesSection(dec, onCountry, includeModifierState) {
    walkSection(dec, (key) => {
      if (key !== "database") return false;
      walkDatabase(dec, (number, obj) => {
        onCountry(Clausewitz.extractCountryFields(number, obj, includeModifierState));
      });
      return true;
    });
  }

  // Mirrors parseCountriesSection, but for "locations={ locations={...} }" -
  // a flat map of ~28,573 entries in a large save, keyed by the same
  // 1-based location numbering used by the game's map files.
  function parseLocationsSection(dec, onLocation) {
    walkSection(dec, (key) => {
      if (key !== "locations") return false;
      walkDatabase(dec, (number, obj) => {
        onLocation(Clausewitz.extractLocationFields(number, obj));
      });
      return true;
    });
  }

  // Mirrors parseLocationsSection, but for "diplomacy_manager={ 0={...}
  // dependency={...} war_reparations={...} ... }" - most entries are keyed
  // by country number (a large per-pair trust/rivalry section we don't need
  // and skip), with subject/overlord and enforced-reparations relationships
  // appearing as repeated keys mixed in among them.
  function parseDiplomacyManagerSection(dec, onDependency, onWarReparations) {
    walkSection(dec, (key) => {
      if (key === "dependency") {
        const obj = dec.readBareValue();
        if (obj && typeof obj === "object" && !Array.isArray(obj) && !("fixedNum" in obj)) {
          const dep = Clausewitz.extractDependencyFields(obj);
          if (typeof dep.overlord === "number" && typeof dep.subject === "number") onDependency(dep);
        }
        return true;
      }
      if (key === "war_reparations") {
        const obj = dec.readBareValue();
        if (obj && typeof obj === "object" && !Array.isArray(obj) && !("fixedNum" in obj)) {
          const rep = Clausewitz.extractWarReparationsFields(obj);
          if (typeof rep.payer === "number" && typeof rep.receiver === "number") {
            if (typeof rep.startDate === "number") rep.startDate = dateFromHours(rep.startDate);
            if (typeof rep.expirationDate === "number") rep.expirationDate = dateFromHours(rep.expirationDate);
            onWarReparations(rep);
          }
        }
        return true;
      }
      return false;
    });
  }

  function parseEstateManagerSection(dec, onAsset, onEstateIncome, onEstateMembership) {
    walkSection(dec, (key) => {
      if (key !== "database") return false;
      walkDatabase(dec, (number, assetObj) => {
        const asset = Clausewitz.extractEstateAssetFields(number, assetObj);
        if (
          asset &&
          onEstateMembership &&
          asset.existence === true &&
          typeof asset.country === "number" &&
          typeof asset.estateType === "string"
        ) {
          onEstateMembership({ country: asset.country, estateType: asset.estateType });
        }
        // Roads dropped here too - see the matching comment in
        // js/clausewitz.js's copy of this filter.
        if (asset && (asset.building || typeof asset.rgo === "number")) onAsset(asset);
        // The country-per-estate-type income-summary shape - see the
        // matching comment in js/clausewitz.js's copy of this filter.
        if (asset && onEstateIncome && typeof asset.country === "number" && (typeof asset.tradeIncome === "number" || typeof asset.paidTaxes === "number"))
          onEstateIncome(asset);
      });
      return true;
    });
  }

  function parseBuildingManagerSection(dec, onBuilding) {
    walkSection(dec, (key) => {
      if (key !== "database") return false;
      walkDatabase(dec, (number, buildingObj) => {
        const building = Clausewitz.extractBuildingFields(number, buildingObj);
        if (building && building.type && typeof building.location === "number") onBuilding(building);
      });
      return true;
    });
  }

  function parseNamedDatabaseSection(dec, onEntry) {
    walkSection(dec, (key) => {
      if (key !== "database") return false;
      walkDatabase(dec, (number, obj) => {
        const entry = Clausewitz.extractNamedDefinitionFields(number, obj);
        if (entry) onEntry(entry);
      });
      return true;
    });
  }

  function parseMarketManagerSection(dec, onMarket) {
    walkSection(dec, (key) => {
      // market_manager's own first field is `produced_goods` (0x324d), not
      // `database` directly - accepted alongside "database" the same way
      // handleSpecialKey's own shape-check already did before this section
      // parser is ever invoked, so any of the historically-seen shapes
      // reaching here is fine to just treat generically.
      if (key !== "database") return false;
      walkDatabase(dec, (number, obj) => {
        const entry = Clausewitz.extractMarketFields(number, obj);
        if (entry) onMarket(entry);
      });
      return true;
    });
  }

  // Binary twin of js/clausewitz.js's parsePlainDatabaseSection: a generic
  // "<section>={ database={ <n>={...} } }" walker for sections whose
  // entries need no per-section quirks - each entry is decoded generically
  // and handed to onEntry(number, obj). Used by the trade/subunit sections.
  function parsePlainDatabaseSection(dec, onEntry) {
    walkSection(dec, (key) => {
      if (key !== "database") return false;
      walkDatabase(dec, (number, obj) => {
        onEntry(typeof number === "number" ? number : NaN, obj);
      });
      return true;
    });
  }

  function parseProvincesSection(dec, onProvince) {
    walkSection(dec, (key) => {
      if (key !== "database") return false;
      walkDatabase(dec, (number, obj) => {
        const definition = typeof obj.province_definition === "string" ? obj.province_definition : null;
        const owner = typeof obj.owner === "number" ? obj.owner : null;
        if (definition) onProvince({ definition, owner });
      });
      return true;
    });
  }

  function parseSituationManagerSection(dec, onBlackDeath) {
    walkSection(dec, (key) => {
      if (key !== "black_death") return false;
      const obj = dec.readBareValue();
      if (obj && typeof obj === "object" && !Array.isArray(obj) && !("fixedNum" in obj)) onBlackDeath(obj);
      return true;
    });
  }

  function parseWarManagerSection(dec, onWar) {
    walkSection(dec, (key) => {
      if (key !== "database") return false;
      walkDatabase(dec, (number, warObj) => {
        const war = Clausewitz.extractWarFields(number, convertWarDatesBinary(warObj));
        if (war) onWar(war);
      });
      return true;
    });
  }

  function parseLoanManagerSection(dec, onLoan) {
    walkSection(dec, (key) => {
      if (key !== "database") return false;
      walkDatabase(dec, (number, loanObj) => {
        const loan = Clausewitz.extractLoanFields(loanObj);
        if (loan) onLoan(loan);
      });
      return true;
    });
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
  // disease_outbreak_manager.data (skipping the huge per-location
  // resistance/immunity "locations" sub-object each entry also carries) and
  // sums each entry's "countries" (per-country death tallies) for the
  // outbreak matching targetIdentity.
  function parseDiseaseOutbreakManagerSection(dec, targetIdentity) {
    const deathsByCountry = {};

    function parseDeathEntry() {
      let diseaseOutbreak = null;
      let amount = null;
      while (true) {
        if (dec.peekKind() === TAPE_CLOSE) {
          dec.pos += 1;
          break;
        }
        const resolved = dec.resolveToken();
        const k = dec.keyToPropName(resolved);
        dec.pos += 1; // EQUALS
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
        if (dec.peekKind() === TAPE_CLOSE) {
          dec.pos += 1;
          break;
        }
        const resolved = dec.resolveToken();
        const k = dec.keyToPropName(resolved);
        dec.pos += 1; // EQUALS
        if (k === "county") {
          const v = dec.readBareValue();
          county = typeof v === "number" ? v : null;
        } else if (k === "deaths" && dec.peekKind() === TAPE_OPEN) {
          dec.pos += 1;
          while (true) {
            if (dec.peekKind() === TAPE_CLOSE) {
              dec.pos += 1;
              break;
            }
            if (dec.peekKind() !== TAPE_OPEN) {
              dec.skipBareValue();
              continue;
            }
            dec.pos += 1;
            const d = parseDeathEntry();
            if (d.diseaseOutbreak === targetIdentity && typeof d.amount === "number") total += d.amount;
          }
        } else {
          dec.skipBareValue();
        }
      }
      if (county !== null) deathsByCountry[county] = (deathsByCountry[county] || 0) + total;
    }

    function parseTypeEntry() {
      while (true) {
        if (dec.peekKind() === TAPE_CLOSE) {
          dec.pos += 1;
          break;
        }
        const resolved = dec.resolveToken();
        const k = dec.keyToPropName(resolved);
        dec.pos += 1; // EQUALS
        if (k === "countries" && dec.peekKind() === TAPE_OPEN) {
          dec.pos += 1;
          while (true) {
            if (dec.peekKind() === TAPE_CLOSE) {
              dec.pos += 1;
              break;
            }
            if (dec.peekKind() !== TAPE_OPEN) {
              dec.skipBareValue();
              continue;
            }
            dec.pos += 1;
            parseCountryEntry();
          }
        } else {
          // "locations" (huge) / "type" / "date" / "current" - none needed.
          dec.skipBareValue();
        }
      }
    }

    walkSection(dec, (key) => {
      if (key !== "data" || dec.peekKind() !== TAPE_OPEN) return false;
      dec.pos += 1;
      while (true) {
        if (dec.peekKind() === TAPE_CLOSE) {
          dec.pos += 1;
          break;
        }
        if (dec.peekKind() !== TAPE_OPEN) {
          dec.skipBareValue();
          continue;
        }
        dec.pos += 1;
        parseTypeEntry();
      }
      return true;
    });

    return deathsByCountry;
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

  // Clausewitz.extractWarFields expects start_date/end_date/joined.date/
  // left.date to already be "Y.M.D" strings (true for the text parser's
  // output) - the binary decoder hands back raw hour counts instead (same
  // encoding as metadata.date), so convert the handful of date fields in
  // place before handing the object to the shared extractor.
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

  async function parseCompressedSave(arrayBuffer, options) {
    options = options || {};
    const onProgress = options.onProgress || function () {};
    let bytes = new Uint8Array(arrayBuffer);

    const headerText = utf8Decode(new DataView(bytes.buffer, bytes.byteOffset, Math.min(64, bytes.length)), 0, Math.min(64, bytes.length));
    const nl = headerText.indexOf("\n");
    if (nl === -1 || !headerText.startsWith("SAV")) throw new Error("not an EU5 save file");
    const bodyStart = nl + 1;

    let zipStart = -1;
    for (let i = bodyStart; i < bytes.length - 4; i++) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x03 && bytes[i + 3] === 0x04) {
        zipStart = i;
        break;
      }
    }
    if (zipStart === -1) throw new Error("could not find embedded zip in save file");

    let metadataBytes = bytes.subarray(bodyStart, zipStart);
    onProgress(0.1);

    let zipBytes = bytes.subarray(zipStart);
    const entries = await extractZipEntries(zipBytes, ["gamestate", "string_lookup"]);
    onProgress(0.4);

    let strings = parseStringLookup(entries.string_lookup);
    onProgress(0.5);

    const metadata = parseMetadataBlock(metadataBytes, strings);
    onProgress(0.55);

    let gsView = new DataView(entries.gamestate.buffer, entries.gamestate.byteOffset, entries.gamestate.byteLength);
    const includeLocations = !!options.includeLocations;
    const includeWars = !!options.includeWars;
    const includeModifierState = !!options.includeModifierState;
    const result = {
      metadata,
      // Set below if tokenizing hit a truncated/corrupted tail, or the
      // semantic walk had to bail out early. null means fully parsed - NOT
      // a guarantee every section was understood, just that nothing threw.
      // A caller that silently trusts an empty players/wars/locations array
      // without checking this can't tell "genuinely empty" apart from "the
      // parser gave up partway through" - which is exactly how a real save
      // produced 25 straight autosave snapshots that looked like clean,
      // complete zero-player/zero-war recordings instead of the parse
      // failures they actually were (see CHANGELOG).
      parseWarning: null,
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

    // Drop the raw input buffer and the (already-fully-consumed) string_lookup
    // zip entry here instead of leaving them reachable via this function's
    // own local scope for the rest of the parse. `strings` and `gsView` (the
    // inflated gamestate) can NOT be freed this early anymore - unlike the
    // old two-phase tape, the streaming decoder below reads directly from
    // `gsView` and looks up `strings` throughout the whole walk, not just in
    // an upfront pass - but eliminating the tape entirely more than makes up
    // for it (see makeDecoder's 2026-08-12 comment for the real measured
    // numbers).
    arrayBuffer = null;
    bytes = null;
    zipBytes = null;
    metadataBytes = null;
    entries.string_lookup = null;

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
    let buildingManagerSeen = false;
    let cultureManagerSeen = false;
    let religionManagerSeen = false;
    let marketManagerSeen = false;
    let situationManagerSeen = false;
    let warManagerSeen = false;
    let diseaseOutbreakManagerSeen = false;
    let provincesSeen = false;
    let loanManagerSeen = false;
    let tradePathManagerSeen = false;
    let tradeManagerSeen = false;
    let populationSeen = false;
    let internationalOrganizationManagerSeen = false;
    let characterDbSeen = false;
    let workOfArtManagerSeen = false;
    function handleSpecialKey(key) {
      if (key === "countries" && !countriesSeen) {
        if (peekFirstKeyOfObject(dec) !== "tags") return false;
        countriesSeen = true;
        parseCountriesSection(
          dec,
          (country) => {
            result.countries.push(country);
            result.countriesByNumber.set(country.number, country);
          },
          includeModifierState
        );
        return true;
      }
      if (key === "played_country") {
        const obj = dec.readBareValue();
        if (obj && typeof obj === "object" && !Array.isArray(obj) && typeof obj.name === "string" && typeof obj.country === "number") {
          result.players.push(extractPlayer(obj));
        }
        return true;
      }
      if (key === "international_organization_manager" && includeModifierState && !internationalOrganizationManagerSeen) {
        const firstKey = peekFirstKeyOfObject(dec);
        // Some saves begin with destroy_ios before database; the generic
        // database walker skips every non-database field either way.
        if (firstKey !== "database" && firstKey !== "#382c") return false;
        internationalOrganizationManagerSeen = true;
        parsePlainDatabaseSection(dec, (number, obj) => {
          const organization = Clausewitz.extractInternationalOrganizationFields(number, obj);
          if (organization) result.internationalOrganizations.push(organization);
        });
        return true;
      }
      if ((key === "character_db" || key === "work_of_art_manager") && includeModifierState) {
        const seen = key === "character_db" ? characterDbSeen : workOfArtManagerSeen;
        if (seen) return false;
        if (dec.peekKind() !== TAPE_OPEN) return false;
        if (key === "character_db") characterDbSeen = true;
        else workOfArtManagerSeen = true;
        parsePlainDatabaseSection(dec, (number, obj) => {
          const entry = key === "character_db" ? Clausewitz.extractCharacterSocietalFields(number, obj) : Clausewitz.extractWorkOfArtSocietalFields(number, obj);
          if (entry) (key === "character_db" ? result.societalCharacters : result.societalWorksOfArt).push(entry);
        });
        return true;
      }
      if (key === "locations" && includeLocations && !locationsSeen) {
        if (peekFirstKeyOfObject(dec) !== "locations") return false;
        locationsSeen = true;
        parseLocationsSection(dec, (location) => {
          result.locations.push(location);
        });
        return true;
      }
      if (key === "population" && includeLocations && !populationSeen) {
        if (peekFirstKeyOfObject(dec) !== "database") return false;
        populationSeen = true;
        parsePlainDatabaseSection(dec, (number, obj) => {
          const pop = Clausewitz.extractPopFields(number, obj);
          if (pop) result.popRecords.push(pop);
        });
        return true;
      }
      // dependencies are small (hundreds of entries) - always parsed, no
      // includeLocations-style opt-in needed.
      if (key === "diplomacy_manager" && !diplomacySeen) {
        if (dec.peekKind() !== TAPE_OPEN) return false;
        diplomacySeen = true;
        parseDiplomacyManagerSection(
          dec,
          (dep) => {
            result.dependencies.push(dep);
          },
          (rep) => {
            result.warReparations.push(rep);
          }
        );
        return true;
      }
      if (key === "estate_manager" && includeLocations && !estateManagerSeen) {
        if (peekFirstKeyOfObject(dec) !== "database") return false;
        estateManagerSeen = true;
        result.estateManagerSeen = true;
        parseEstateManagerSection(
          dec,
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
        return true;
      }
      if (key === "building_manager" && includeLocations && !buildingManagerSeen) {
        if (peekFirstKeyOfObject(dec) !== "database") return false;
        buildingManagerSeen = true;
        parseBuildingManagerSection(dec, (building) => {
          result.buildings.push(building);
        });
        return true;
      }
      if ((key === "culture_manager" || key === "religion_manager") && includeLocations) {
        if (key === "culture_manager" && cultureManagerSeen) return false;
        if (key === "religion_manager" && religionManagerSeen) return false;
        if (peekFirstKeyOfObject(dec) !== "database") return false;
        if (key === "culture_manager") {
          cultureManagerSeen = true;
          parseNamedDatabaseSection(dec, (entry) => result.cultures.push(entry));
        } else {
          religionManagerSeen = true;
          parseNamedDatabaseSection(dec, (entry) => result.religions.push(entry));
        }
        return true;
      }
      if (key === "market_manager" && includeLocations && !marketManagerSeen) {
        const firstKey = peekFirstKeyOfObject(dec);
        // See the module-level comment on parseMarketManagerSection for why
        // both spellings of the produced_goods signature are accepted.
        if (firstKey !== "database" && firstKey !== "#324d" && firstKey !== "produced_goods") return false;
        marketManagerSeen = true;
        parseMarketManagerSection(dec, (entry) => result.markets.push(entry));
        return true;
      }
      if (key === "provinces" && includeLocations && !provincesSeen) {
        if (peekFirstKeyOfObject(dec) !== "database") return false;
        provincesSeen = true;
        parseProvincesSection(dec, (p) => {
          result.provinceOwnerByDefinition[p.definition] = p.owner;
        });
        return true;
      }
      if (key === "situation_manager" && !situationManagerSeen) {
        if (peekFirstKeyOfObject(dec) !== "black_death") return false;
        situationManagerSeen = true;
        parseSituationManagerSection(dec, (obj) => {
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
        if (peekFirstKeyOfObject(dec) !== "database") return false;
        diseaseOutbreakManagerSeen = true;
        result.blackDeath.deathsByCountry = parseDiseaseOutbreakManagerSection(dec, result.blackDeath.identity);
        return true;
      }
      if (key === "loan_manager" && !loanManagerSeen) {
        if (peekFirstKeyOfObject(dec) !== "database") return false;
        loanManagerSeen = true;
        parseLoanManagerSection(dec, (loan) => {
          result.countryDebt.set(loan.borrower, (result.countryDebt.get(loan.borrower) || 0) + loan.amount);
        });
        return true;
      }
      if (key === "subunit_manager" && !result.subunitManagerSeen) {
        if (peekFirstKeyOfObject(dec) !== "database") return false;
        result.subunitManagerSeen = true;
        parsePlainDatabaseSection(dec, (number, obj) => {
          const ship = Clausewitz.extractNavalSubunit(obj);
          if (ship) result.navalSubunits.push(ship);
          const troop = Clausewitz.extractArmySubunit(obj);
          if (troop) result.armySubunits.push(troop);
        });
        return true;
      }
      if (key === "trade_path_manager" && includeLocations && !tradePathManagerSeen) {
        if (peekFirstKeyOfObject(dec) !== "database") return false;
        tradePathManagerSeen = true;
        parsePlainDatabaseSection(dec, (number, obj) => {
          const path = Clausewitz.extractTradePathFields(number, obj);
          if (path) result.tradePaths.push(path);
        });
        return true;
      }
      if (key === "trade_manager" && includeLocations && !tradeManagerSeen) {
        if (peekFirstKeyOfObject(dec) !== "database") return false;
        tradeManagerSeen = true;
        parsePlainDatabaseSection(dec, (number, obj) => {
          const trade = Clausewitz.extractTradeFields(number, obj);
          if (trade) result.trades.push(trade);
        });
        return true;
      }
      if (key === "war_manager" && includeWars && !warManagerSeen) {
        const firstKey = peekFirstKeyOfObject(dec);
        // Pre-1.3 saves omit the "names" naming-template block entirely and
        // go straight to "database" - accept either shape.
        if (firstKey !== "names" && firstKey !== "database") return false;
        warManagerSeen = true;
        parseWarManagerSection(dec, (war) => {
          result.wars.push(war);
        });
        return true;
      }
      return false;
    }

    // Single streaming pass over the gamestate (0.55 -> 1.0): tokenizes and
    // walks simultaneously, never materializing a full in-memory tape (see
    // makeDecoder's 2026-08-12 comment) - this used to be two separate
    // phases (tokenize the whole buffer, then walk the result) with a large
    // intermediate array held in memory for the whole walk.
    const dec = makeDecoder(gsView, strings, { onSpecialKey: handleSpecialKey, onProgress: (frac) => onProgress(0.55 + 0.45 * frac) });

    try {
      while (dec.peekKind() !== undefined) {
        // Normally every top-level gamestate entry is "key=value", but a
        // real multiplayer save (274MB gamestate, 2500+ countries, 8
        // players) was found with a run of bare (unkeyed) entries sitting
        // between diplomacy_manager and war_manager - small anonymous
        // {target={type=... identity=...}} records, structurally identical
        // to the array elements the nested walker (skipBody) already
        // tolerates everywhere else. Tolerating bare entries at the true
        // top level too (skip and keep going) fixed a real save that came
        // back with 0 players/wars/locations despite parsing 2542 real
        // countries correctly.
        const peek = dec.peekKind();
        if (peek === TAPE_OPEN) {
          dec.skipBareValue();
        } else {
          const resolved = dec.resolveToken();
          if (dec.peekKind() === TAPE_EQUALS) {
            dec.pos += 1;
            const key = dec.keyToPropName(resolved);
            if (!handleSpecialKey(key)) {
              dec.skipBareValue();
            }
          }
          // else: a bare scalar sibling of the OPEN case above, already
          // consumed by resolveToken() - fall through and keep going.
        }
      }
      // A genuinely truncated/corrupted tail that happened to end exactly at
      // the true top level (not mid-section) exits the loop above normally
      // instead of throwing - still worth flagging, just discovered here
      // instead of in the catch below.
      if (dec.truncated) {
        result.parseWarning = `Gamestate truncated or corrupted around byte ${dec.byteOffset} - some sections may be missing.`;
      }
    } catch (err) {
      // Truncated save, or a structural quirk we haven't seen - keep
      // whatever countries/players were successfully extracted rather than
      // losing everything to one bad section.
      result.parseWarning = `Save parsing stopped early at byte ${dec.byteOffset}: ${err.message}. Some sections (possibly players/wars/locations) may be missing or incomplete.`;
      if (typeof console !== "undefined" && console.warn) {
        console.warn("EU5 save parsing stopped early (partial results kept):", err.message);
      }
    }

    // The walk is done - drop the inflated gamestate buffer and the string
    // lookup table now, before the postprocessing calls below build further
    // on `result` (they only ever touch `result`, never these).
    entries.gamestate = null;
    strings = null;
    gsView = null;

    // See js/clausewitz.js's collapsePlayerSessions for why "last entry per
    // country wins, then dedupe by player name across countries too" (no
    // explicit timestamp on these, but file order reflects recency) - shared
    // logic, not duplicated here.
    Clausewitz.collapsePlayerSessions(result);
    Clausewitz.attachLocationAssets(result);
    Clausewitz.attachLocationBuildings(result);
    Clausewitz.reconcileWarOccupation(result);
    Clausewitz.attachCountryDebt(result);
    Clausewitz.attachTradeRoutes(result);
    Clausewitz.attachNavyCounts(result);
    Clausewitz.attachArmyCounts(result);
    Clausewitz.attachActiveEstateTypes(result);
    Clausewitz.attachSocietalSourceFacts(result);

    onProgress(1);
    return result;
  }

  return { parseCompressedSave, parseStringLookup, extractZipEntries, makeDecoder, parseMetadataBlock };
});
