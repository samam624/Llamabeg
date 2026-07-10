// Parses a single compressed save (no matching melted file needed) and
// prints a sanity summary - for spot-checking saves from patches we don't
// have a melted ground-truth copy of.
const fs = require("fs");
const path = require("path");
const { parseCompressedSave } = require(path.join(__dirname, "..", "js", "clausewitz-binary.js"));

const file = process.argv[2];

async function main() {
  const buf = fs.readFileSync(file);
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  let lastPct = -1;
  const t0 = Date.now();
  const result = await parseCompressedSave(arrayBuffer, {
    onProgress: (f) => {
      const pct = Math.floor(f * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        process.stdout.write(`\rParsing... ${pct}%`);
      }
    },
  });
  console.log(`\nParsed in ${Date.now() - t0}ms`);

  console.log("\n--- Metadata ---");
  console.log("Playthrough:", result.metadata.playthrough_name);
  console.log("Player country:", result.metadata.player_country_name);
  console.log("Date:", result.metadata.date);
  console.log("Version:", result.metadata.version);
  console.log("DLCs:", result.metadata.enabled_dlcs);

  console.log("\n--- Countries ---");
  console.log("Total country entries:", result.countries.length);
  const real = result.countries.filter((c) => c.countryType === "Real");
  console.log("Real countries:", real.length);

  // Look for unresolved fixed IDs ("#hex" keys) in a sample of countries -
  // a sign the ID table is missing entries for this game version.
  const unresolvedKeys = new Set();
  for (const c of real.slice(0, 50)) {
    for (const k of Object.keys(c)) {
      // extractCountryFields already maps to friendly names, so check the
      // raw fields it captured as undefined that shouldn't be.
    }
  }
  const missingFieldCounts = {};
  const fieldsToCheck = [
    "tag", "countryType", "scorePlace", "admScore", "gold", "manpower", "stability",
    "prestige", "totalProduced", "lastMonthGoldIncome", "governmentType", "capital",
  ];
  for (const f of fieldsToCheck) missingFieldCounts[f] = 0;
  for (const c of real) {
    for (const f of fieldsToCheck) {
      if (c[f] === undefined) missingFieldCounts[f]++;
    }
  }
  console.log("\n--- Field coverage (undefined count out of", real.length, "real countries) ---");
  console.log(missingFieldCounts);

  console.log("\n--- Players ---");
  console.log("Total players:", result.players.length);
  for (const p of result.players) {
    console.log(
      `  ${p.name}: ${p.country ? p.country.tag : "?"} (country #${p.countryNumber})`,
      p.country ? `gold=${p.country.gold} scorePlace=${p.country.scorePlace}` : "(no matching country!)"
    );
  }

  console.log("\n--- Sample country (first real) ---");
  console.log(JSON.stringify(real[0], null, 2));
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
