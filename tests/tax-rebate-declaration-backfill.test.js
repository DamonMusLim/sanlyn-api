import assert from "node:assert/strict";
import { test } from "node:test";

import {
  containerNosArray,
  contractNoTokens,
  missingShippingPlanSkipRecord,
  ownerCompanyIdFromRows,
  shippingPlanResolution,
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

test("contractNoTokens splits multi-contract values", () => {
  assert.deepEqual(
    contractNoTokens("FS20260220049/FS20260220051, FS20260220057；FS20260220058"),
    ["FS20260220049", "FS20260220051", "FS20260220057", "FS20260220058"]
  );
});

test("shippingPlanResolution selects the only matching shipping plan id", () => {
  assert.deepEqual(
    shippingPlanResolution("FS20260204007", [{ _id: "25722479-f457-4d92-a839-981dc0e51d89" }]),
    {
      tokens: ["FS20260204007"],
      candidates: ["25722479-f457-4d92-a839-981dc0e51d89"],
      shipping_plan_id: "25722479-f457-4d92-a839-981dc0e51d89",
      skipped: false,
    }
  );
});

test("shippingPlanResolution sorts multiple candidate ids and preserves all candidates", () => {
  assert.deepEqual(
    shippingPlanResolution("FS20260220041/FS20260220042", [
      { _id: "mmx_YMJAI228527803" },
      { _id: "20ee171925ec4372af9057fa" },
      { _id: "mmx_YMJAI228527803" },
    ]),
    {
      tokens: ["FS20260220041", "FS20260220042"],
      candidates: ["20ee171925ec4372af9057fa", "mmx_YMJAI228527803"],
      shipping_plan_id: "20ee171925ec4372af9057fa",
      skipped: false,
    }
  );
});

test("shippingPlanResolution marks declarations with no shipping plan candidates as skippable", () => {
  const skipped_declarations = [];
  const resolution = shippingPlanResolution("FS404", []);
  assert.deepEqual(
    resolution,
    {
      tokens: ["FS404"],
      candidates: [],
      shipping_plan_id: null,
      skipped: true,
    }
  );
  assert.doesNotThrow(() => {
    if (resolution.skipped) {
      skipped_declarations.push(missingShippingPlanSkipRecord({
        customs_no: "422720260000000000",
        declaration_no: "422720260000000000",
        declaration_index: 1,
        contract_no: "FS404",
      }));
    }
  });
  assert.deepEqual(skipped_declarations, [{
    customs_no: "422720260000000000",
    declaration_no: "422720260000000000",
    declaration_index: 1,
    contract_no: "FS404",
    reason: "contract_no has no matching shipping_plans._id",
  }]);
});
