---
name: reverse-engineer-eu5-binary-field
description: Find an EU5 binary-save field's fixed ID / structure when it isn't in js/eu5-fixed-ids.js yet, using a real save and js/clausewitz-binary.js's own generic decoding fallback - no external tools needed. Use whenever a country-state fact the modifier optimizer (or any other feature) needs isn't showing up for a binary-format save, or when extending js/clausewitz-binary.js to parse a new field.
---

# Finding an unmapped EU5 binary save field

EU5's binary (`.eu5`, format code `03`) save encodes every key as a 16-bit
token: either a well-known fixed ID (`js/eu5-fixed-ids.js`) or an opaque
enum-like value the parser doesn't resolve yet. `js/clausewitz-binary.js`
already decodes anything unmapped generically instead of crashing - a
missing key just falls back to a value that's still fully inspectable,
which is what makes this workflow possible without any external save editor.

## Step 0: check for a melted (plaintext) save first

`melted_saves/` (repo root) has plaintext-melted versions of a subset of
real saves, matched to the compressed `.eu5` by UUID (see
`test_save_data` memory for which UUIDs have a pair). Grepping plaintext is
dramatically faster than binary reverse-engineering - always try this first:

```bash
grep -n "your_suspected_field_name" melted_saves/autosave_<uuid>_melted.eu5
```

If the melted save doesn't have the data you need (predates the mechanic,
wrong country, or no melted copy exists for the save you care about), only
then move to the binary approach below. (2026-07-19: this happened for
real - none of the 6 available melted saves had an active Hellenist omen to
learn the structure from, forcing the binary approach.)

## Step 1: capture the raw pre-extraction object for one country

`js/clausewitz.js`'s `extractCountryFields(number, obj, includeModifierState)`
is called by **both** parsers (binary reuses the text parser's field-mapping
logic) with `obj` = the fully generically-decoded raw country object -
every key the save actually has, including ones with no fixed-ID mapping
(those show up as `"#" + hex` keys, e.g. `"#36ea"`). Monkey-patch it to
capture that raw object for the one country you care about, then run the
**real, unmodified** parse pipeline on the **actual real save file**:

```js
const Clausewitz = require("./js/clausewitz.js");
const ClausewitzBinary = require("./js/clausewitz-binary.js");
const fs = require("fs");

const origExtract = Clausewitz.extractCountryFields;
let captured = null;
Clausewitz.extractCountryFields = function (number, obj, includeModifierState) {
  const result = origExtract.call(this, number, obj, includeModifierState);
  if (result && result.tag === "BYZ") captured = obj; // match by tag, not number - country numbers aren't stable identifiers to hardcode
  return result;
};

const bytes = fs.readFileSync("path/to/real.eu5");
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
ClausewitzBinary.parseCompressedSave(buffer, { includeWars: false, includeLocations: false, includeModifierState: true, playerWarsOnly: true })
  .then(() => { /* inspect `captured` here */ })
  .catch((err) => console.error(err.stack));
```

`includeWars`/`includeLocations: false` keeps this fast on a large save -
they don't gate country-level decoding.

## Step 2: scan the captured object for the shape you're looking for

Don't eyeball a huge `JSON.stringify` dump by hand - write a small recursive
scan for the specific shape you expect:

- **A "history" field** (a player choice with a change date, same shape as
  `implemented_laws`/`implemented_privileges`/`implemented_reforms`/
  `implemented_gods`): an array of `{date, object}` (sometimes also `days`).
  ```js
  function scan(obj, path) {
    if (Array.isArray(obj)) {
      if (obj.length && obj.every((e) => e && typeof e === "object" && !Array.isArray(e) && "date" in e && "object" in e)) {
        console.log("ARRAY-OF-DATE-OBJECT at", path, JSON.stringify(obj.slice(0, 3)));
      }
      obj.forEach((v, i) => v && typeof v === "object" && scan(v, `${path}[${i}]`));
      return;
    }
    if (obj && typeof obj === "object") for (const [k, v] of Object.entries(obj)) v && typeof v === "object" && scan(v, `${path}.${k}`);
  }
  ```
- **A still-unresolved VALUE token** (an enum-like value with no fixed-ID
  mapping at all, distinct from an unmapped KEY): `{ fixedNum: <number> }`
  with exactly one own key. Same recursive shape, checking
  `typeof obj.fixedNum === "number" && Object.keys(obj).length === 1`.
- **A specific literal string you expect** (e.g. an omen/trait/tag ID):
  `JSON.stringify(captured).includes("the_string_you_expect")`, or better,
  check the save's global string table directly (every string used anywhere
  in the save lives there, not just where you expect it):
  ```js
  const entries = await cb.extractZipEntries(bytes.subarray(zipStart), ["gamestate", "string_lookup"]);
  const strings = cb.parseStringLookup(entries.string_lookup);
  console.log(strings.filter((s) => typeof s === "string" && s.includes("your_substring")));
  ```
  A string's mere *presence* in this table doesn't prove it's currently
  active/selected anywhere - only that it was referenced somewhere in the
  save's history. Don't over-read presence/absence as a proxy for "this is
  the current value" without corroborating evidence.

## Step 3: check top-level `gamestate` keys too, not just inside the country

Some per-country-feeling state actually lives in a separate **top-level
manager section**, keyed by something other than country number (confirmed
real: `religion_manager`'s `database` turned out to be keyed by religion
definition ID, not country number - a red herring that cost real time before
checking `international_organization_manager`/`character_db`/`loan_manager`
existed as siblings). Dump all top-level keys once to see what's available:

```js
const dec = cb.makeDecoder(gsView, strings);
const keys = [];
while (dec.pos < gsBytes.length) {
  const peek = gsView.getUint16(dec.pos, true);
  if (peek === 4) break; // CLOSE
  const key = dec.keyToPropName(dec.resolveToken());
  if (gsView.getUint16(dec.pos, true) !== 1) break; // desync guard (1 = EQUALS)
  dec.pos += 2;
  keys.push(key);
  dec.skipBareValue();
}
console.log(keys);
```

`test/debug-loan-manager.js` is the established template for walking into
one specific already-identified top-level manager once you know its name
(it also demonstrates the desync-detection pattern above).

## Step 4: once found, wire it in properly

- Add the fixed ID to `js/eu5-fixed-ids.js` (follow its existing comment-
  block convention documenting how each ID was byte-verified).
- Extend `extractCountryFields`/`parseCountriesSection` (or the relevant
  top-level manager handler) to surface the field.
- **Cross-check against a melted counterpart if one exists** -
  `test/run-binary.js "save games/<name>.eu5" "melted_saves/<name>_melted.eu5"`
  - text/binary parity is this project's standing verification gate for
    every parser addition (see `binary_parser_version_fixes` memory).
- If no melted save covers the new field, at minimum re-run the monkey-patch
  capture from Step 1 after your change and confirm the field now appears
  under its real name instead of `#hex`.

## Gotchas

- Country **numbers change/get reassigned** across a long game (annexation,
  reformation) - always match a specific country by **tag**, not by a
  hardcoded number, when capturing.
- A `{fixedNum}` sentinel and an unmapped `"#hex"` key look similar but are
  different things: one is an unresolved VALUE, the other is an unresolved
  KEY name (`keyToPropName`'s fallback). Both matter, but grep for them
  differently (see Step 2).
- Don't assume a mechanic works the way its UI screenshots suggest without
  checking the save - EU5's Hellenism omens turned out to store *which gods
  are unlocked* (`implemented_gods`, a simple history array) completely
  separately from *which omen is currently selected per ability slot*
  (never found, despite checking the government block, all country-level
  fields, `religion_manager`, and the global string table - confirm with
  the user in-game rather than guessing further once a reasonable search
  comes up empty).
