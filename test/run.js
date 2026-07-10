// Node-only sanity/perf test against a real melted save file.
// Usage: node test/run.js "C:\path\to\..._melted.eu5"
const fs = require("fs");
const path = require("path");
const { parseSave } = require(path.join(__dirname, "..", "js", "clausewitz.js"));

const file = process.argv[2];
if (!file) {
  console.error("Usage: node test/run.js <melted-save-path>");
  process.exit(1);
}

console.log("Reading", file, "...");
let t0 = Date.now();
const text = fs.readFileSync(file, "utf8");
console.log(`Read ${(text.length / 1e6).toFixed(1)}MB in ${Date.now() - t0}ms`);

t0 = Date.now();
let lastPct = -1;
const result = parseSave(text, {
  onProgress: (frac) => {
    const pct = Math.floor(frac * 100);
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

console.log("\n--- Players ---");
console.log("Total players:", result.players.length);
for (const p of result.players) {
  console.log(
    `  ${p.name}: ${p.country ? p.country.tag : "?"} (country #${p.countryNumber})`,
    p.country ? `gold=${p.country.gold} scorePlace=${p.country.scorePlace}` : "(no matching country!)"
  );
}

console.log("\n--- Sample country (first 3 real) ---");
console.log(JSON.stringify(real.slice(0, 3), null, 2));

const mem = process.memoryUsage();
console.log("\n--- Memory ---");
console.log("RSS:", (mem.rss / 1e6).toFixed(0), "MB");
console.log("Heap used:", (mem.heapUsed / 1e6).toFixed(0), "MB");
