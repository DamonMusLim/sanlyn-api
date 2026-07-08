import assert from "node:assert/strict";
import {
  auditAmountAllocation,
  auditSelectionSource,
  riskMax
} from "../api/db/slip-core.js";

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function hasCandidates(raw) {
  return Array.isArray(raw?.match_candidates) && raw.match_candidates.length > 0;
}

async function legacyAuditAmount(pool, slip) {
  const r = await pool.query(
    "SELECT COALESCE(SUM(amount_alloc),0) AS allocated FROM bank_slip_links WHERE slip_id=$1",
    [slip.id]
  );
  const slipAmount = money(slip.amount);
  const allocated = money(r.rows[0]?.allocated);
  const diff = money(Math.abs(slipAmount - allocated));
  const threshold = money(Math.max(10, Math.abs(slipAmount) * 0.005));
  let severity = "low";
  if (diff >= 0.01 && diff > threshold) severity = "high";
  else if (diff >= 0.01) severity = "medium";
  return {
    rule: "amount_allocation_mismatch",
    severity,
    message: severity === "low" ? "分摊金额合计与银行实收金额一致" : "分摊金额合计与银行实收金额存在差异",
    slip_amount: slipAmount,
    allocated_amount: allocated,
    diff,
    threshold
  };
}

async function legacyAuditSource(pool, slip) {
  const r = await pool.query(
    "SELECT selection_source, COUNT(*)::int AS count FROM bank_slip_links WHERE slip_id=$1 GROUP BY selection_source",
    [slip.id]
  );
  const total = r.rows.reduce((n, row) => n + Number(row.count || 0), 0);
  const manual = r.rows.filter(row => row.selection_source === "manual_input").reduce((n, row) => n + Number(row.count || 0), 0);
  let severity = "low";
  if (manual > 0) severity = "medium";
  if (total > 0 && manual === total && hasCandidates(slip.raw)) severity = "high";
  return {
    rule: "selection_source",
    severity,
    message: severity === "low" ? "确认分摊来自 OCR 候选" : "确认分摊包含人工手动输入",
    total_allocations: total,
    manual_allocations: manual,
    had_ocr_candidates: hasCandidates(slip.raw)
  };
}

function fakePool({ allocated, sourceRows }) {
  return {
    queries: [],
    async query(sql, params) {
      this.queries.push({ sql, params });
      if (sql.includes("SUM(amount_alloc)")) return { rows: [{ allocated }] };
      if (sql.includes("GROUP BY selection_source")) return { rows: sourceRows };
      throw new Error(`unexpected SQL: ${sql}`);
    }
  };
}

const cases = [
  { slip: { id: 1, amount: 1000, raw: { match_candidates: [{ shipment_no: "CY00365" }] } }, allocated: 1000, sourceRows: [{ selection_source: "ocr_candidate", count: 1 }] },
  { slip: { id: 2, amount: 1000, raw: { match_candidates: [{ shipment_no: "CY00365" }] } }, allocated: 995, sourceRows: [{ selection_source: "manual_input", count: 1 }] },
  { slip: { id: 3, amount: 1000, raw: { match_candidates: [{ shipment_no: "CY00365" }] } }, allocated: 980, sourceRows: [{ selection_source: "manual_input", count: 2 }] },
  { slip: { id: 4, amount: 1000, raw: {} }, allocated: 1000, sourceRows: [{ selection_source: "manual_input", count: 1 }, { selection_source: "ocr_candidate", count: 1 }] }
];

for (const item of cases) {
  const oldAmount = await legacyAuditAmount(fakePool(item), item.slip);
  const newAmount = await auditAmountAllocation(fakePool(item), {
    linksTable: "bank_slip_links",
    slipId: item.slip.id,
    slipAmount: item.slip.amount
  });
  assert.deepEqual(newAmount, oldAmount);

  const oldSource = await legacyAuditSource(fakePool(item), item.slip);
  const newSource = await auditSelectionSource(fakePool(item), {
    linksTable: "bank_slip_links",
    slipId: item.slip.id,
    raw: item.slip.raw
  });
  assert.deepEqual(newSource, oldSource);
}

assert.equal(riskMax("low", "medium"), "medium");
assert.equal(riskMax("high", "medium"), "high");

await assert.rejects(
  () => auditAmountAllocation(fakePool(cases[0]), { linksTable: "bank_slip_links;DROP TABLE x", slipId: 1, slipAmount: 1 }),
  /unsupported slip links table/
);

console.log("slip-core regression passed");
