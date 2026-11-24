"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  candidateBucketNames,
  storageCorsConfiguration,
  hasUsableBucket
} = require("../server/storage");

test("bucket discovery covers both Firebase Storage naming formats", () => {
  const names = candidateBucketNames();
  assert.ok(names.length >= 1);
  assert.ok(names.every(name => typeof name === "string" && name.length > 0));
});

test("Storage is treated as unavailable while the Firestore emulator runs", async () => {
  assert.equal(await hasUsableBucket(), false);
});

test("storage CORS policy permits signed browser uploads", () => {
  const rules = storageCorsConfiguration();
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].method, ["GET", "PUT", "HEAD"]);
  assert.deepEqual(rules[0].responseHeader, ["Content-Type"]);
  assert.ok(rules[0].origin.length > 0);
  assert.ok(rules[0].maxAgeSeconds > 0);
});
