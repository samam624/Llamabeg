// Runs one save's read+hash+parse on a worker thread instead of the main
// thread - see parseFilesInParallel() in llama-log-machine.js for why. Kept
// as a small standalone script (not a function passed to `new Worker()`)
// since worker_threads needs a real file to load as the thread's entry
// point.
"use strict";

const { parentPort, workerData } = require("worker_threads");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const Clausewitz = require(path.join(__dirname, "../js/clausewitz.js"));
const ClausewitzBinary = require(path.join(__dirname, "../js/clausewitz-binary.js"));

async function parseOne(file, playerWarsOnly) {
  const bytes = fs.readFileSync(file);
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const header = bytes.subarray(0, 7);
  const headerText = header.toString("utf8");
  if (!headerText.startsWith("SAV")) throw new Error("Not an EU5 save file");
  const formatCode = headerText.slice(5, 7);

  // Mirrors readAndParseSave() in llama-log-machine.js exactly (including
  // includeLocations: true - see that function's comment for why it's
  // needed even though this recorder has no direct use for map data).
  if (formatCode === "00") {
    const text = bytes.toString("utf8");
    return {
      hash,
      result: Clausewitz.parseSave(text, {
        includeWars: true,
        includeLocations: true,
        includeModifierState: true,
        playerWarsOnly: !!playerWarsOnly,
      }),
    };
  }
  if (formatCode === "03") {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return {
      hash,
      result: await ClausewitzBinary.parseCompressedSave(buffer, {
        includeWars: true,
        includeLocations: true,
        includeModifierState: true,
        playerWarsOnly: !!playerWarsOnly,
      }),
    };
  }
  throw new Error(`Unsupported save format code ${formatCode}`);
}

parseOne(workerData.file, workerData.playerWarsOnly)
  .then(({ hash, result }) => parentPort.postMessage({ ok: true, hash, result }))
  .catch((err) => parentPort.postMessage({ ok: false, error: err.message, code: err.code }));
