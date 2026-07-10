// Walks a compressed save's gamestate top level like clausewitz-binary.js
// does, but with verbose position tracking, to pinpoint exactly where a
// desync happens on a save from an unvalidated game patch.
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

  let entryIdx = 0;
  const EQUALS = 1,
    OPEN = 3;
  try {
    while (dec.pos < gsBytes.length) {
      const beforePos = dec.pos;
      const resolved = dec.resolveToken();
      const key = dec.keyToPropName(resolved);
      const eq = gsView.getUint16(dec.pos, true);
      if (eq !== EQUALS) {
        console.log(`Top-level desync at pos ${dec.pos}: key=${JSON.stringify(key)} not followed by EQUALS (got 0x${eq.toString(16)})`);
        break;
      }
      dec.pos += 2;
      const startPos = dec.pos;
      dec.skipBareValue();
      console.log(`${entryIdx}\t${key}\tstart@${beforePos}\tsize=${dec.pos - startPos}`);
      entryIdx++;
    }
  } catch (err) {
    console.log(`\nCRASHED after ${entryIdx} top-level entries, at pos ${dec.pos}`);
    console.log("Error:", err.message);
    const ctxStart = Math.max(0, dec.pos - 40);
    const ctx = gsBytes.subarray(ctxStart, Math.min(gsBytes.length, dec.pos + 40));
    console.log("Context hex (pos-40 to pos+40):", Buffer.from(ctx).toString("hex"));
    console.log("Buffer length:", gsBytes.length);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
