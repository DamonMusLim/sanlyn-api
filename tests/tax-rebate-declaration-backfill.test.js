import assert from "node:assert/strict";
import { test } from "node:test";

import { containerNosArray } from "../api/db/tax-rebate-declaration-backfill.js";

test("containerNosArray splits comma-separated container values", () => {
  assert.deepEqual(containerNosArray("2,MSMU6537966"), ["2", "MSMU6537966"]);
});

test("containerNosArray keeps a single container value as one array element", () => {
  assert.deepEqual(containerNosArray("MRSU3915091"), ["MRSU3915091"]);
});

test("containerNosArray returns null for missing values", () => {
  assert.equal(containerNosArray(""), null);
  assert.equal(containerNosArray(null), null);
});
