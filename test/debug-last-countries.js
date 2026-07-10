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
  while (dec.pos < gsBytes.length) {
    const resolved = dec.resolveToken();
    const key = dec.keyToPropName(resolved);
    dec.pos += 2;
    if (key === "countries") break;
    dec.skipBareValue();
  }
  dec.pos += 2; // OPEN of countries

  const lastCountries = [];
  while (true) {
    const peek = gsView.getUint16(dec.pos, true);
    if (peek === CLOSE) {
      dec.pos += 2;
      break;
    }
    const resolved = dec.resolveToken();
    const key = dec.keyToPropName(resolved);
    dec.pos += 2; // equals
    if (key === "tags") {
      dec.skipBareValue();
    } else if (key === "database") {
      dec.pos += 2; // OPEN
      while (true) {
        const p2 = gsView.getUint16(dec.pos, true);
        if (p2 === CLOSE) {
          dec.pos += 2;
          break;
        }
        const numResolved = dec.resolveToken();
        dec.pos += 2; // equals
        const startPos = dec.pos;
        const countryObj = dec.readBareValue();
        const extracted = require("../js/clausewitz.js").extractCountryFields(numResolved, countryObj);
        lastCountries.push({ number: numResolved, endPos: dec.pos, extracted, rawKeys: Object.keys(countryObj) });
        if (lastCountries.length > 10) lastCountries.shift();
      }
    } else {
      dec.skipBareValue();
    }
  }

  console.log("Last 10 countries in database:");
  for (const c of lastCountries) {
    console.log(`\n#${c.number} endPos=${c.endPos}`);
    console.log("  tag:", c.extracted.tag, "countryType:", c.extracted.countryType, "gold:", c.extracted.gold, "scorePlace:", c.extracted.scorePlace);
    console.log("  raw key count:", c.rawKeys.length, "last few raw keys:", c.rawKeys.slice(-5));
  }
  console.log("\nFinal pos after countries:", dec.pos);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
