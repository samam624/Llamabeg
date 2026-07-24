const assert = require("assert");
const path = require("path");
const LlamaScore = require(path.join(__dirname, "..", "js", "llama-score.js"));

const active = {
  date: "1457.2.1",
  countries: {
    203: { players: ["Zuup"] },
  },
};

const partial = {
  date: "1458.2.1",
  countries: {
    203: { players: [] },
  },
  parseWarning: "Partial parser result: player roster may be incomplete.",
};

assert.deepStrictEqual(
  [...LlamaScore.computeDepartedPlayers([active, partial])],
  [],
  "A parser-warning snapshot must not turn a missing roster into a departure"
);

const genuineDeparture = {
  date: "1459.2.1",
  countries: {
    203: { players: [] },
  },
};

assert.deepStrictEqual(
  [...LlamaScore.computeDepartedPlayers([active, partial, genuineDeparture])],
  ["Zuup"],
  "An unflagged empty roster must still record a genuine departure"
);

const reconnected = {
  date: "1460.2.1",
  countries: {
    203: { players: ["Zuup"] },
  },
};

assert.deepStrictEqual(
  [...LlamaScore.computeDepartedPlayers([active, partial, genuineDeparture, reconnected])],
  [],
  "A later valid roster must restore an active player"
);

console.log("departed-player parse-warning tests passed");
