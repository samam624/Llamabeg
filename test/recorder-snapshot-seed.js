"use strict";

const assert = require("assert");
const Recorder = require("../llama-score-automatic-logging-machine/llama-log-machine.js");

const parsed = {
  metadata: { date: "1500.1.1", playthrough_name: "Seed test", version: "test" },
  players: [{ countryNumber: 1 }],
  playerSessions: [],
  countries: [
    { number: 1, tag: "AAA", players: ["Player"], ownedLocations: [10, 11] },
    { number: 2, tag: "BBB", players: [], ownedLocations: [20] },
    { number: 3, tag: "CCC", players: [], ownedLocations: [30] },
    { number: 4, tag: "DDD", players: [], ownedLocations: [40] },
  ],
  dependencies: [{ overlord: 3, subject: 4, subjectType: "vassal" }],
  wars: [],
  cultures: [],
  religions: [],
  internationalOrganizations: [],
  warReparations: [],
  parseWarning: null,
};

const previousWars = {
  9: {
    lastWar: {
      number: 9,
      originalAttacker: 3,
      originalDefenders: [1],
      participants: [
        { country: 3, side: "Attacker" },
        { country: 1, side: "Defender" },
      ],
    },
  },
};

const config = { playerWarsOnly: true, storeAllEconomyCountries: false };
const seed = Recorder.buildSnapshotSeed("autosave_seed-test.eu5", "hash", parsed, config);
const clonedSeed = structuredClone(seed);
const snapshot = Recorder.finalizeSnapshotSeed(clonedSeed, config, previousWars);

assert.strictEqual(seed.countrySummaries.length, 4);
assert.ok(!Object.prototype.hasOwnProperty.call(seed, "locations"));
assert.ok(!Object.prototype.hasOwnProperty.call(seed, "popRecords"));
assert.deepStrictEqual(Object.keys(snapshot.countries), ["1", "3", "4"]);
assert.deepStrictEqual(snapshot.countries[3].ownedLocations, [30]);
assert.deepStrictEqual(snapshot.countries[4].ownedLocations, [40]);
assert.ok(!snapshot.countries[2]);

const allSnapshot = Recorder.finalizeSnapshotSeed(seed, { playerWarsOnly: true, storeAllEconomyCountries: true }, previousWars);
assert.deepStrictEqual(Object.keys(allSnapshot.economyCountries), ["1", "2", "3", "4"]);
assert.ok(!Object.prototype.hasOwnProperty.call(allSnapshot.economyCountries[3], "ownedLocations"));

console.log("recorder snapshot seed: ok");
