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

  const dec = cb.makeDecoder(gsView, strings, { debug: true });
  dec.pos = 59629186;
  dec.resolveToken(); // market_manager key
  dec.pos += 2; // equals
  dec.pos += 2; // OPEN

  // field 0: #324d
  let r = dec.resolveToken();
  console.log("field0 key:", dec.keyToPropName(r));
  dec.pos += 2; // equals
  dec.skipBareValue();
  console.log("field0 done, pos", dec.pos);

  // field 1: database - decode its entries one at a time like
  // countries.database, printing each numeric key + size.
  r = dec.resolveToken();
  console.log("field1 key:", dec.keyToPropName(r));
  dec.pos += 2; // equals
  const openCode = gsView.getUint16(dec.pos, true);
  console.log("field1 value openCode", openCode.toString(16), "at pos", dec.pos);
  dec.pos += 2;

  let idx = 0;
  let lastGood = null;
  try {
    while (true) {
      const peek = gsView.getUint16(dec.pos, true);
      if (peek === CLOSE) {
        console.log("database CLOSE at", dec.pos, "after", idx, "entries");
        dec.pos += 2;
        break;
      }
      const beforePos = dec.pos;
      const numResolved = dec.resolveToken();
      const eq = gsView.getUint16(dec.pos, true);
      if (eq !== EQUALS) {
        console.log(`NOT keyed at ${beforePos}: resolved=${JSON.stringify(numResolved)} next=0x${eq.toString(16)}`);
        break;
      }
      dec.pos += 2;
      const valStart = dec.pos;
      dec.skipBareValue();
      lastGood = { key: numResolved, start: beforePos, size: dec.pos - valStart };
      idx++;
      if (idx % 20000 === 0) console.log(`...${idx} entries, last key=${JSON.stringify(numResolved)} pos=${dec.pos}`);
    }
    console.log(`Finished database cleanly after ${idx} entries, pos ${dec.pos}`);
  } catch (err) {
    console.log(`CRASHED after ${idx} entries at pos ${dec.pos}: ${err.message}`);
    console.log("Last good entry:", JSON.stringify(lastGood));
  }

  const anomalies = dec.getDebugAnomalies();
  console.log(`\nAnomalies during database decode: ${anomalies.length}`);
  const near = anomalies.filter((a) => a.pos >= 59955000 && a.pos <= 59956000);
  console.log("Anomalies near pos 59955566:", JSON.stringify(near));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
