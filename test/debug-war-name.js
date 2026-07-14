// One-off exploratory script that derived war_name's binary fixed ID
// (0x2b1a) by generically decoding war_manager.database's first entry
// (unmapped keys fall back to "#hex") and matching its shape - an object
// containing a "name" key (already a known fixed ID, resolved without help)
// alongside ordinal/bases sub-keys - against the melted plaintext's known
// war_name={name=... ordinal=... bases={...}} structure for the same save.
// Same derivation pattern as debug-loan-manager.js/debug-war-reparations.js.
// Confirmed: war 0 in autosave_10729752-... decodes to
// war_name.name="CIVIL_WAR_NAME" in both text and binary parsers.
const fs = require("fs");
const cb = require("../js/clausewitz-binary.js");

async function main() {
  const file = process.argv[2];
  const buf = fs.readFileSync(file);
  const bytes = new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const nl = bytes.indexOf(10);
  const bodyStart = nl + 1;
  let zipStart = -1;
  for (let i = bodyStart; i < bytes.length - 4; i++) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x03 && bytes[i + 3] === 0x04) {
      zipStart = i;
      break;
    }
  }
  const entries = await cb.extractZipEntries(bytes.subarray(zipStart), ["gamestate", "string_lookup"]);
  const strings = cb.parseStringLookup(entries.string_lookup);
  const gsBytes = entries.gamestate;
  const gsView = new DataView(gsBytes.buffer, gsBytes.byteOffset, gsBytes.byteLength);
  const dec = cb.makeDecoder(gsView, strings);

  const EQUALS = 1;
  let entryIdx = 0;
  while (dec.pos < gsBytes.length) {
    const resolved = dec.resolveToken();
    const key = dec.keyToPropName(resolved);
    const eq = gsView.getUint16(dec.pos, true);
    if (eq !== EQUALS) {
      console.log(`desync at entry ${entryIdx}, key=${key}`);
      return;
    }
    dec.pos += 2;
    if (key === "war_manager") {
      const peek = gsView.getUint16(dec.pos, true);
      if (peek !== 3) {
        console.log("war_manager value isn't an OPEN block, got code", peek);
        return;
      }
      dec.pos += 2;
      const body = dec.decodeBody();
      const db = body.database;
      const firstKey = Object.keys(db)[0];
      const war = db[firstKey];
      console.log("First war entry number:", firstKey);
      console.log("Top-level keys:", Object.keys(war));
      for (const [k, v] of Object.entries(war)) {
        if (v && typeof v === "object" && !Array.isArray(v) && "name" in v) {
          console.log(`\nCandidate war_name key=${k}:`, JSON.stringify(v));
        }
      }
      return;
    }
    dec.skipBareValue();
    entryIdx++;
  }
  console.log("war_manager not found");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
