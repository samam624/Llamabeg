// One-off exploratory script that derived war_reparations' binary fixed ID
// (0x36d7) and expiration_date's (0x2827) by generically decoding
// diplomacy_manager (unmapped keys fall back to "#hex") and value-matching
// the {first, second, start_date, expiration_date} entries against the
// melted plaintext's known war_reparations entries for the same save - same
// derivation pattern as debug-loan-manager.js. All 6 entries in
// autosave_10729752-2bb9-4170-86a9-2bddb274563a matched exactly, in order.
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
    if (key === "diplomacy_manager") {
      const peek = gsView.getUint16(dec.pos, true);
      if (peek !== 3) {
        console.log("diplomacy_manager value isn't an OPEN block, got code", peek);
        return;
      }
      dec.pos += 2;
      const body = dec.decodeBody();
      const list = Array.isArray(body["#36d7"]) ? body["#36d7"] : [body["#36d7"]];
      console.log(`#36d7 entries (count=${list.length}) - compare against the melted text's war_reparations= blocks:`);
      for (const item of list) console.log(JSON.stringify(item));
      return;
    }
    dec.skipBareValue();
    entryIdx++;
  }
  console.log("diplomacy_manager not found");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
