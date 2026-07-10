// Reverse-engineering scratch script: extracts the raw pieces of a compressed
// EU5 save (pre-zip metadata block, gamestate, string_lookup) so we can
// inspect the binary format byte-by-byte against the known-correct melted
// text of the same save.
const fs = require("fs");
const zlib = require("zlib");

const file = process.argv[2];
const buf = fs.readFileSync(file);

// Header line: "SAV0203....\n"
const nl = buf.indexOf(0x0a);
const header = buf.slice(0, nl).toString("ascii");
console.log("Header:", header);
const bodyStart = nl + 1;

// Find the embedded zip's first local file header.
const zipStart = buf.indexOf(Buffer.from("PK\x03\x04"), bodyStart);
console.log("Zip starts at offset", zipStart, "(metadata block is", zipStart - bodyStart, "bytes)");

const metadataBlock = buf.slice(bodyStart, zipStart);

function readLocalFileEntry(offset) {
  if (buf.readUInt32LE(offset) !== 0x04034b50) throw new Error("not a local file header at " + offset);
  const compMethod = buf.readUInt16LE(offset + 8);
  const compSize = buf.readUInt32LE(offset + 18);
  const uncompSize = buf.readUInt32LE(offset + 22);
  const nameLen = buf.readUInt16LE(offset + 26);
  const extraLen = buf.readUInt16LE(offset + 28);
  const name = buf.slice(offset + 30, offset + 30 + nameLen).toString("ascii");
  const dataStart = offset + 30 + nameLen + extraLen;
  const compData = buf.slice(dataStart, dataStart + compSize);
  const data = compMethod === 0 ? compData : zlib.inflateRawSync(compData);
  return { name, uncompSize, data, nextOffset: dataStart + compSize };
}

let offset = zipStart;
const entries = {};
while (buf.readUInt32LE(offset) === 0x04034b50) {
  const entry = readLocalFileEntry(offset);
  console.log(`Entry: ${entry.name}  compressed->decompressed, decoded ${entry.data.length} bytes (expected ${entry.uncompSize})`);
  entries[entry.name] = entry.data;
  offset = entry.nextOffset;
}

fs.writeFileSync(file + ".metadata.bin", metadataBlock);
fs.writeFileSync(file + ".gamestate.bin", entries.gamestate);
fs.writeFileSync(file + ".string_lookup.bin", entries.string_lookup);
console.log("\nWrote .metadata.bin, .gamestate.bin, .string_lookup.bin next to the input file.");
