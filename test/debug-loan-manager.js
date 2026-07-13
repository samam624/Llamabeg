// One-off exploratory script to derive loan_manager's binary structure by
// decoding it generically (unmapped keys fall back to "#hex") and comparing
// against the melted plaintext's known field order/values for the same save.
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
      console.log(`desync at entry ${entryIdx}`);
      return;
    }
    dec.pos += 2;
    if (key === "loan_manager") {
      const peek = gsView.getUint16(dec.pos, true);
      if (peek !== 3) {
        console.log("loan_manager value isn't an OPEN block, got code", peek);
        return;
      }
      dec.pos += 2;
      const body = dec.decodeBody();
      const dbEntries = body.database ? Object.entries(body.database).slice(0, 5) : [];
      console.log("loan_manager top-level keys:", Object.keys(body));
      console.log("first 5 database entries:");
      for (const [k, v] of dbEntries) console.log(k, JSON.stringify(v));
      return;
    }
    dec.skipBareValue();
    entryIdx++;
  }
  console.log("loan_manager not found");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
