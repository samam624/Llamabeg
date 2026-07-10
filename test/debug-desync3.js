// Uses the actual production skipBody/resolveToken (with debug ring buffer
// enabled) to find exactly where a top-level entry desyncs.
const fs = require("fs");
const cb = require("../js/clausewitz-binary.js");

async function main() {
  const file = process.argv[2];
  const targetEntryIndex = parseInt(process.argv[3], 10);
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

  // Fast-forward through entries before target using non-debug decoder.
  const fastDec = cb.makeDecoder(gsView, strings);
  for (let i = 0; i < targetEntryIndex; i++) {
    const resolved = fastDec.resolveToken();
    const eq = gsView.getUint16(fastDec.pos, true);
    if (eq !== EQUALS) throw new Error(`desync before target at entry ${i}`);
    fastDec.pos += 2;
    fastDec.skipBareValue();
  }
  console.log(`Reached entry ${targetEntryIndex} at pos ${fastDec.pos}`);

  // Now switch to a debug-enabled decoder sharing the same position.
  const dec = cb.makeDecoder(gsView, strings, { debug: true });
  dec.pos = fastDec.pos;
  const resolved = dec.resolveToken();
  const key = dec.keyToPropName(resolved);
  console.log("Entry key:", key);
  const eq = gsView.getUint16(dec.pos, true);
  if (eq !== EQUALS) throw new Error("expected EQUALS");
  dec.pos += 2;

  try {
    dec.skipBareValue();
    console.log("Finished cleanly, final pos", dec.pos);
  } catch (err) {
    console.log("CRASHED at pos", dec.pos, ":", err.message);
    console.log("\n--- Last tokens before crash ---");
    for (const r of dec.getDebugRing()) console.log(JSON.stringify(r));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
