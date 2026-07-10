// Tests the production binary parser end-to-end against the real compressed
// save, and cross-checks its output against the melted-text parser's output
// for the SAME save (our ground truth).
const fs = require("fs");
const path = require("path");
const { parseCompressedSave } = require(path.join(__dirname, "..", "js", "clausewitz-binary.js"));
const { parseSave } = require(path.join(__dirname, "..", "js", "clausewitz.js"));

const compressedFile = process.argv[2];
const meltedFile = process.argv[3];

async function main() {
  console.log("Reading compressed save...");
  const compressedBuf = fs.readFileSync(compressedFile);
  const arrayBuffer = compressedBuf.buffer.slice(compressedBuf.byteOffset, compressedBuf.byteOffset + compressedBuf.byteLength);

  let t0 = Date.now();
  let lastPct = -1;
  const binResult = await parseCompressedSave(arrayBuffer, {
    onProgress: (f) => {
      const pct = Math.floor(f * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        process.stdout.write(`\rParsing binary... ${pct}%`);
      }
    },
  });
  console.log(`\nBinary parse done in ${Date.now() - t0}ms`);
  console.log("Countries:", binResult.countries.length, "Players:", binResult.players.length);
  console.log("Metadata date:", binResult.metadata.date, "playthrough:", binResult.metadata.playthrough_name);

  console.log("\nReading melted text save for comparison...");
  const meltedText = fs.readFileSync(meltedFile, "utf8");
  t0 = Date.now();
  const textResult = parseSave(meltedText, {});
  console.log(`Text parse done in ${Date.now() - t0}ms`);
  console.log("Countries:", textResult.countries.length, "Players:", textResult.players.length);

  // Cross-check metadata.
  console.log("\n--- Metadata comparison ---");
  for (const field of ["date", "playthrough_name", "version", "player_country_name"]) {
    const match = binResult.metadata[field] === textResult.metadata[field];
    console.log(`${field}: bin=${JSON.stringify(binResult.metadata[field])} text=${JSON.stringify(textResult.metadata[field])} ${match ? "OK" : "MISMATCH"}`);
  }

  // Cross-check every country's key numeric fields.
  console.log("\n--- Country comparison (all fields, all countries) ---");
  const fields = [
    "tag", "countryType", "level", "capital", "scorePlace", "admScore", "dipScore", "milScore",
    "gold", "manpower", "sailors", "stability", "prestige", "armyTradition", "navyTradition",
    "religiousInfluence", "inflation", "totalProduced", "lastMonthGoldIncome",
    "lastMonthManpowerIncome", "lastMonthSailorsIncome", "maxManpower", "maxSailors",
    "governmentType", "courtLanguage", "aiPersonality",
  ];
  let mismatches = 0;
  let checked = 0;
  for (const textCountry of textResult.countries) {
    const binCountry = binResult.countriesByNumber.get(textCountry.number);
    if (!binCountry) {
      console.log(`MISSING in binary: country #${textCountry.number} (${textCountry.tag})`);
      mismatches++;
      continue;
    }
    for (const f of fields) {
      checked++;
      const tv = textCountry[f];
      const bv = binCountry[f];
      const bothNaN = typeof tv === "number" && typeof bv === "number" && Number.isNaN(tv) && Number.isNaN(bv);
      const numericClose = typeof tv === "number" && typeof bv === "number" && Math.abs(tv - bv) < 0.001;
      if (tv !== bv && !bothNaN && !numericClose) {
        if (mismatches < 30) {
          console.log(`MISMATCH country #${textCountry.number} (${textCountry.tag}).${f}: text=${JSON.stringify(tv)} bin=${JSON.stringify(bv)}`);
        }
        mismatches++;
      }
    }
  }
  console.log(`\nChecked ${checked} field values across ${textResult.countries.length} countries: ${mismatches} mismatches`);

  // Cross-check players.
  console.log("\n--- Player comparison ---");
  const textPlayers = new Set(textResult.players.map((p) => p.name + "|" + p.countryNumber));
  const binPlayers = new Set(binResult.players.map((p) => p.name + "|" + p.countryNumber));
  const onlyInText = [...textPlayers].filter((p) => !binPlayers.has(p));
  const onlyInBin = [...binPlayers].filter((p) => !textPlayers.has(p));
  console.log("Text players:", textPlayers.size, "Binary players:", binPlayers.size);
  console.log("Only in text:", onlyInText);
  console.log("Only in binary:", onlyInBin);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
