const fs = require("fs");
const path = require("path");
const Clausewitz = require("../js/clausewitz.js");

const rootDir = path.resolve(__dirname, "..");
const savesDir = path.join(rootDir, "melted_saves");
const outPath = path.join(rootDir, "assets", "home-political-snapshot.json");
const locationMetaPath = path.join(rootDir, "map_data", "locations.json");
const preferredHomeSaveName = "autosave_3baa76aa-825a-4655-ae49-02edd3b90a4b_melted.eu5";

function readSaveDate(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytes).toString("utf8");
    const match = text.match(/(?:^|\n)\s*date\s*=\s*([0-9.]+)/);
    return match ? match[1] : null;
  } finally {
    fs.closeSync(fd);
  }
}

function dateSortValue(date) {
  if (!date) return [Number.POSITIVE_INFINITY];
  return date.split(".").map((part) => Number(part) || 0);
}

function compareDates(a, b) {
  const left = dateSortValue(a);
  const right = dateSortValue(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function selectedMeltedSave() {
  const preferredPath = path.join(savesDir, preferredHomeSaveName);
  if (fs.existsSync(preferredPath)) {
    return { filePath: preferredPath, stats: fs.statSync(preferredPath), date: readSaveDate(preferredPath), preferred: true };
  }

  const files = fs
    .readdirSync(savesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /_melted\.eu5$/i.test(entry.name))
    .map((entry) => {
      const filePath = path.join(savesDir, entry.name);
      return { filePath, stats: fs.statSync(filePath), date: readSaveDate(filePath) };
    })
    .sort((a, b) => compareDates(a.date, b.date) || b.stats.mtimeMs - a.stats.mtimeMs);

  if (!files.length) throw new Error("No *_melted.eu5 files found in melted_saves/");
  return files[0];
}

const selectedSave = selectedMeltedSave();
const savePath = selectedSave.filePath;
console.log(`Building home political snapshot from ${path.relative(rootDir, savePath)} (${selectedSave.date || "unknown date"})`);
const text = fs.readFileSync(savePath, "utf8");
const parsed = Clausewitz.parseSave(text, { includeLocations: true, includeWars: false });
const locationMeta = JSON.parse(fs.readFileSync(locationMetaPath, "utf8"));

const countries = parsed.countries
  .filter((country) => Number.isFinite(country.number) && country.color)
  .map((country) => [country.number, country.color]);

const provinceOwners = parsed.provinceOwnerByDefinition || {};
let provinceFallbackCount = 0;
const locationOwners = new Map();
for (const location of parsed.locations) {
  if (!Number.isFinite(location.number)) continue;
  const meta = locationMeta[String(location.number)];
  if (!meta || meta.type === "sea" || meta.type === "lake") continue;

  let owner = Number.isFinite(location.owner) ? location.owner : null;
  if (!owner && meta.province && Number.isFinite(provinceOwners[meta.province])) {
    owner = provinceOwners[meta.province];
    provinceFallbackCount += 1;
  }
  if (owner) locationOwners.set(location.number, owner);
}

const landLocations = Object.entries(locationMeta)
  .filter(([, meta]) => meta && meta.type !== "sea" && meta.type !== "lake")
  .map(([id]) => Number(id))
  .filter(Number.isFinite);

const locations = parsed.locations
  .map((location) => location.number)
  .filter((locationNumber) => Number.isFinite(locationNumber) && locationOwners.has(locationNumber))
  .map((locationNumber) => [locationNumber, locationOwners.get(locationNumber)]);

const snapshot = {
  version: 2,
  source: path.relative(rootDir, savePath).replace(/\\/g, "/"),
  date: parsed.metadata && parsed.metadata.date ? parsed.metadata.date : null,
  countries,
  landLocations,
  locations,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(snapshot));
console.log(
  `Wrote ${path.relative(rootDir, outPath)} (${countries.length} countries, ${locations.length} owned land locations, ${provinceFallbackCount} province fallback owners)`
);
