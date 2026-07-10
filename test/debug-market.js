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
  const EQUALS = 1,
    OPEN = 3,
    CLOSE = 4;

  const dec = cb.makeDecoder(gsView, strings);
  dec.pos = 59629186; // start of entry 29 (market_manager), from prior run

  const resolved = dec.resolveToken();
  console.log("Entry key:", dec.keyToPropName(resolved));
  const eq = gsView.getUint16(dec.pos, true);
  dec.pos += 2;
  const openCode = gsView.getUint16(dec.pos, true);
  dec.pos += 2;
  console.log("Body starts at", dec.pos, "openCode", openCode.toString(16));

  // Walk depth-1 (market_manager's own top level) fields only, using
  // skipBareValue for each value (whatever its depth), printing each.
  let idx = 0;
  while (true) {
    const peek = gsView.getUint16(dec.pos, true);
    if (peek === CLOSE) {
      console.log("market_manager CLOSE at", dec.pos, "- finished cleanly after", idx, "fields");
      dec.pos += 2;
      break;
    }
    const beforePos = dec.pos;
    const r = dec.resolveToken();
    const key = dec.keyToPropName(r);
    const eq2 = gsView.getUint16(dec.pos, true);
    if (eq2 !== EQUALS) {
      console.log(`NOT A KEY at pos ${beforePos}: resolved=${JSON.stringify(r)}, next=0x${eq2.toString(16)}`);
      break;
    }
    dec.pos += 2;
    const valStart = dec.pos;
    try {
      dec.skipBareValue();
    } catch (err) {
      console.log(`CRASH decoding value for key "${key}" (started at ${beforePos}): ${err.message}`);
      break;
    }
    console.log(`${idx}\t${key}\tstart@${beforePos}\tsize=${dec.pos - valStart}`);
    idx++;
    if (idx > 300) {
      console.log("...stopping after 300 fields for brevity...");
      break;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
