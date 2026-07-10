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
    OPEN = 3;

  const dec = cb.makeDecoder(gsView, strings, { debug: true });
  dec.pos = 59629186; // start of 0x2e94
  dec.resolveToken();
  dec.pos += 2; // equals
  const openCode = gsView.getUint16(dec.pos, true);
  dec.pos += 2;
  if (openCode !== OPEN) throw new Error("expected subobject");

  try {
    dec.skipBody();
    console.log("Finished cleanly at pos", dec.pos);
  } catch (err) {
    console.log("Crashed at pos", dec.pos, ":", err.message);
  }

  const anomalies = dec.getDebugAnomalies();
  console.log(`\nTotal anomalies: ${anomalies.length}`);
  const byCode = {};
  for (const a of anomalies) {
    const k = a.type + " 0x" + a.code.toString(16);
    byCode[k] = (byCode[k] || 0) + 1;
  }

  // Focus on VALUE-position anomalies (SKIP/SCALAR_VALUE, not RESOLVE which
  // fires for every ordinary unmapped key name - that's expected noise).
  const valueAnomalies = anomalies.filter((a) => a.type === "UNKNOWN_SKIP" || a.type === "UNKNOWN_SCALAR_VALUE");
  console.log(`\nValue-position anomalies: ${valueAnomalies.length}`);

  // Rare codes (low total frequency) are more likely to be garbage from an
  // earlier drift than a legitimate, consistently-used marker type.
  const rare = valueAnomalies.filter((a) => byCode[a.type + " 0x" + a.code.toString(16)] < 10);
  rare.sort((a, b) => a.pos - b.pos);
  console.log(`\nRare (<10 occurrences) value anomalies, in file order, first 40:`);
  for (const a of rare.slice(0, 40)) console.log(JSON.stringify(a), "count=", byCode[a.type + " 0x" + a.code.toString(16)]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
