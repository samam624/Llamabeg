"use strict";

const assert = require("assert");
const { translateArgs } = require("../llama-dashboard/scripts/verify-update-release.js");

assert.deepStrictEqual(
  translateArgs(["--require-signed", "--tag", "v1.2.3"]),
  ["-RequireSigned", "-Tag", "v1.2.3"]
);
assert.deepStrictEqual(translateArgs([]), []);

console.log("update release wrapper: ok");
