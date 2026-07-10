// Deep-dive into whichever top-level entry crashes: keeps a ring buffer of
// the last N tokens processed so we can see the token stream immediately
// before a desync, not just the final out-of-bounds failure point.
const fs = require("fs");
const cb = require("../js/clausewitz-binary.js");

const RING_SIZE = 60;

async function main() {
  const file = process.argv[2];
  const targetEntryIndex = parseInt(process.argv[3], 10); // which top-level entry to deep-dive
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

  // Advance to the start of targetEntryIndex using the library's own skip
  // (trusted for entries before the target).
  const dec = cb.makeDecoder(gsView, strings);
  for (let i = 0; i < targetEntryIndex; i++) {
    const resolved = dec.resolveToken();
    const eq = gsView.getUint16(dec.pos, true);
    if (eq !== EQUALS) throw new Error(`unexpected desync before target at entry ${i}`);
    dec.pos += 2;
    dec.skipBareValue();
  }

  console.log(`Reached start of entry ${targetEntryIndex} at pos ${dec.pos}`);
  const resolved = dec.resolveToken();
  const key = dec.keyToPropName(resolved);
  console.log("Entry key:", key);
  const eq = gsView.getUint16(dec.pos, true);
  if (eq !== EQUALS) throw new Error("expected EQUALS after target key");
  dec.pos += 2;

  const openCode = gsView.getUint16(dec.pos, true);
  if (openCode !== OPEN) {
    console.log("Value is a scalar, not an object, code:", openCode.toString(16));
    return;
  }
  dec.pos += 2;

  // Manual depth-tracked walk with a ring buffer, mirroring skipBody's logic.
  const ring = [];
  function record(entry) {
    ring.push(entry);
    if (ring.length > RING_SIZE) ring.shift();
  }

  let depth = 1;
  let steps = 0;
  try {
    while (depth > 0) {
      steps++;
      const posBefore = dec.pos;
      const peek = gsView.getUint16(dec.pos, true);
      if (peek === CLOSE) {
        dec.pos += 2;
        depth--;
        record({ pos: posBefore, type: "CLOSE", depth });
        continue;
      }
      if (peek === OPEN) {
        dec.pos += 2;
        depth++;
        record({ pos: posBefore, type: "OPEN", depth });
        continue;
      }
      const resolved2 = dec.resolveToken();
      const k = dec.keyToPropName(resolved2);
      const eq2 = gsView.getUint16(dec.pos, true);
      if (eq2 === EQUALS) {
        dec.pos += 2;
        const valPeek = gsView.getUint16(dec.pos, true);
        if (valPeek === OPEN) {
          dec.pos += 2;
          depth++;
          record({ pos: posBefore, type: "KEY+OPEN", key: k, depth });
        } else {
          dec.skipBareValue();
          record({ pos: posBefore, type: "KEY=VALUE", key: k, depth });
        }
      } else {
        record({ pos: posBefore, type: "BAREVALUE", key: k, depth });
      }

      if (steps % 500000 === 0) {
        console.log(`...${steps} steps, pos=${dec.pos}, depth=${depth}`);
      }
    }
    console.log(`Finished entry cleanly after ${steps} steps, final pos ${dec.pos}`);
  } catch (err) {
    console.log(`\nCRASHED after ${steps} steps at pos ${dec.pos}: ${err.message}`);
    console.log("\n--- Last", ring.length, "tokens before crash ---");
    for (const r of ring) console.log(JSON.stringify(r));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
