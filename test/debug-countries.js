// Mirrors parseCountriesSection's actual per-country decode loop (not a
// generic skip) with instrumentation, to find exactly which country /
// field triggers a desync on a save from an unvalidated game patch.
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

  // Fast-forward to "countries" (entry 28 by earlier findings) using the
  // library's normal skip (fine for entries before it).
  while (dec.pos < gsBytes.length) {
    const resolved = dec.resolveToken();
    const key = dec.keyToPropName(resolved);
    const eq = gsView.getUint16(dec.pos, true);
    if (eq !== EQUALS) throw new Error(`desync before countries at pos ${dec.pos}`);
    dec.pos += 2;
    if (key === "countries") {
      console.log("Found countries at pos", dec.pos);
      break;
    }
    dec.skipBareValue();
  }

  const openCode = gsView.getUint16(dec.pos, true);
  if (openCode !== OPEN) throw new Error("expected countries value to be OPEN");
  dec.pos += 2;

  // Now walk countries={ tags={...} database={...} } exactly like
  // parseCountriesSection, but log every country number + byte range.
  let countryCount = 0;
  let lastGoodCountry = null;
  try {
    while (true) {
      const peek = gsView.getUint16(dec.pos, true);
      if (peek === CLOSE) {
        dec.pos += 2;
        break;
      }
      const resolved = dec.resolveToken();
      const key = dec.keyToPropName(resolved);
      const eq = gsView.getUint16(dec.pos, true);
      if (eq !== EQUALS) throw new Error(`desync at countries-level key, pos ${dec.pos}`);
      dec.pos += 2;

      if (key === "tags") {
        console.log("Skipping tags at pos", dec.pos);
        dec.skipBareValue();
        console.log("tags done, pos now", dec.pos);
      } else if (key === "database") {
        const dbOpen = gsView.getUint16(dec.pos, true);
        if (dbOpen !== OPEN) throw new Error("expected database to be OPEN");
        dec.pos += 2;
        console.log("Entering database at pos", dec.pos);
        while (true) {
          const p2 = gsView.getUint16(dec.pos, true);
          if (p2 === CLOSE) {
            dec.pos += 2;
            break;
          }
          const numResolved = dec.resolveToken();
          const eq2 = gsView.getUint16(dec.pos, true);
          if (eq2 !== EQUALS) throw new Error(`desync at database entry key, pos ${dec.pos}, numResolved=${JSON.stringify(numResolved)}`);
          dec.pos += 2;
          const startPos = dec.pos;
          const countryObj = dec.readBareValue();
          countryCount++;
          lastGoodCountry = { number: numResolved, startPos, endPos: dec.pos, size: dec.pos - startPos };
          if (countryCount % 500 === 0) {
            console.log(`...${countryCount} countries decoded, last #${numResolved} pos ${dec.pos}`);
          }
        }
      } else {
        console.log("Skipping unexpected countries-level key", key);
        dec.skipBareValue();
      }
    }
    console.log(`\nFinished countries cleanly. Total countries: ${countryCount}, final pos ${dec.pos}`);
  } catch (err) {
    console.log(`\nCRASHED after ${countryCount} countries.`);
    console.log("Last successfully decoded country:", JSON.stringify(lastGoodCountry));
    console.log("Error:", err.message);
    console.log("Current pos:", dec.pos);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
