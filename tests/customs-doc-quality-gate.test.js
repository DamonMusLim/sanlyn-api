import assert from "node:assert/strict";
import { test } from "node:test";

import { checkContainerCoverage, renderGateBanner } from "../api/db/customs-doc-quality-gate.js";

test("container coverage returns warning when multi-container source tables are unavailable", async () => {
  const pool = {
    async query(sql) {
      assert.match(sql, /FROM order_containers/);
      throw new Error('relation "order_containers" does not exist');
    },
  };

  const coverage = await checkContainerCoverage(pool, { bl_no: "BL-001" }, {
    coveredOrderIds: [101, 102],
  });

  assert.equal(coverage.ok, true);
  assert.equal(coverage.coverage_status, "warning");
  assert.match(coverage.reason, /多柜真源表/);

  const banner = renderGateBanner(coverage, { status: "pass", reasons: [] });
  assert.match(banner, /质量门禁警告/);
  assert.match(banner, /柜覆盖/);
});

test("container coverage blocks a requested container outside the BL", async () => {
  const pool = {
    async query() {
      return { rows: [{ container_no: "MSKU1234567" }] };
    },
  };

  const coverage = await checkContainerCoverage(pool, { bl_no: "BL-001" }, {
    requestedContainerNo: "CMAU7654321",
  });

  assert.equal(coverage.ok, false);
  assert.equal(coverage.coverage_status, "blocked");
  assert.deepEqual(coverage.foreign, ["CMAU7654321"]);
  assert.match(renderGateBanner(coverage, { status: "pass", reasons: [] }), /未通过/);
});
