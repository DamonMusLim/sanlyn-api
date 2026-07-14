import assert from "node:assert/strict";
import { test } from "node:test";

import {
  containerNosArray,
  ownerCompanyIdFromRows,
  pendingShippingPlanId,
} from "../api/db/tax-rebate-declaration-backfill-helpers.js";

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

test("ownerCompanyIdFromRows returns the configured taxpayer company id", () => {
  assert.equal(ownerCompanyIdFromRows([{ id: 37 }]), 37);
});

test("pendingShippingPlanId marks missing plan links explicitly", () => {
  assert.equal(
    pendingShippingPlanId("802346"),
    "pending_shipping_plan_link:802346"
  );
});
