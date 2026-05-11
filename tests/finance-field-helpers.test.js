// tests/finance-field-helpers.test.js
//
// Unit tests + 386-row snapshot replay for the finance helper library.
// Spec: docs/workstreams/2026-05-finance-mainline/finance-helper-rules-v1.md
//
// Run: node --test tests/finance-field-helpers.test.js

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  inferDirection,
  pickAmount,
  pickPaymentDate,
  pickMatchKeys,
} from "../api/lib/finance-field-helpers.js";

// ─────────────────────────────────────────────────────────────────────────────
// Tiny CSV parser (RFC 4180-ish, handles "quoted, commas" and "" escapes)
// ─────────────────────────────────────────────────────────────────────────────

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cell += c;
      }
    } else {
      if (c === '"')         inQuotes = true;
      else if (c === ',')   { row.push(cell); cell = ""; }
      else if (c === '\r')  { /* skip */ }
      else if (c === '\n')  { row.push(cell); rows.push(row); row = []; cell = ""; }
      else                  { cell += c; }
    }
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

function readFixture(text) {
  const rows = parseCsv(text);
  const header = rows.shift();
  const recs = rows.filter(r => r.length === header.length).map(r => {
    const o = {};
    header.forEach((h, i) => { o[h] = r[i]; });
    return o;
  });
  return recs;
}

// ─────────────────────────────────────────────────────────────────────────────
// inferDirection — rule-by-rule unit tests
// ─────────────────────────────────────────────────────────────────────────────

test("inferDirection: R1 direction='AP' → AP", () => {
  const r = inferDirection({ direction: "AP" });
  assert.equal(r.direction, "AP");
  assert.equal(r.reasonCode, "R1_dir_AP_explicit");
  assert.equal(r.confidence, "high");
});

test("inferDirection: R1 direction='付款' → AP", () => {
  assert.equal(inferDirection({ direction: "付款" }).direction, "AP");
});

test("inferDirection: R1 direction='out' → AP", () => {
  assert.equal(inferDirection({ direction: "out" }).direction, "AP");
});

test("inferDirection: R2 pay_item containing '付' → AP", () => {
  const r = inferDirection({ pay_item: "应付款" });
  assert.equal(r.direction, "AP");
  assert.equal(r.reasonCode, "R2_pay_item_contains_pay");
});

test("inferDirection: R3 forwarder_cn set → AP (even with customer_en)", () => {
  const r = inferDirection({ forwarder_cn: "上海洋宝宝", customer_en: "PETSOME" });
  assert.equal(r.direction, "AP");
  assert.equal(r.reasonCode, "R3_forwarder_cn_set");
});

test("inferDirection: R4 pay_item='拖车费' → AP", () => {
  assert.equal(inferDirection({ pay_item: "拖车费" }).reasonCode, "R4_pay_item_cost_AP");
});

test("inferDirection: R5 direction='收款' → AR", () => {
  const r = inferDirection({ direction: "收款" });
  assert.equal(r.direction, "AR");
  assert.equal(r.reasonCode, "R5_dir_AR_explicit");
});

test("inferDirection: R5 direction='in' → AR", () => {
  assert.equal(inferDirection({ direction: "in" }).direction, "AR");
});

test("inferDirection: R6 pay_item='goods' → AR", () => {
  const r = inferDirection({ pay_item: "goods" });
  assert.equal(r.direction, "AR");
  assert.equal(r.reasonCode, "R6_pay_item_goods_AR");
});

test("inferDirection: R6 pay_item='货款' → AR", () => {
  assert.equal(inferDirection({ pay_item: "货款" }).direction, "AR");
});

test("inferDirection: R7 historical PETSOME → AR (medium confidence)", () => {
  const r = inferDirection({
    raw: { source: "historical_orders_to_import.json" },
    customer_en: "PETSOME SDN BHD",
  });
  assert.equal(r.direction, "AR");
  assert.equal(r.reasonCode, "R7_historical_PETSOME");
  assert.equal(r.confidence, "medium");
});

test("inferDirection: R7 does NOT fire for a different customer", () => {
  const r = inferDirection({
    raw: { source: "historical_orders_to_import.json" },
    customer_en: "OTHER CUSTOMER",
  });
  assert.equal(r.direction, "UNCLASSIFIED");
});

test("inferDirection: R8 freight + forwarder_cn → AP", () => {
  // R3 fires first (forwarder_cn) — that's still AP, which is the right answer.
  const r = inferDirection({ pay_item: "freight", forwarder_cn: "ABC Forwarder" });
  assert.equal(r.direction, "AP");
});

test("inferDirection: R9 freight + customer_en, no forwarder → AR", () => {
  const r = inferDirection({ pay_item: "freight", customer_en: "PETSOME" });
  assert.equal(r.direction, "AR");
  assert.equal(r.reasonCode, "R9_freight_from_customer_AR");
});

test("inferDirection: R0 empty row → UNCLASSIFIED", () => {
  const r = inferDirection({});
  assert.equal(r.direction, "UNCLASSIFIED");
  assert.equal(r.reasonCode, "R0_no_signal");
});

test("inferDirection: AP signal wins over customer_en hint", () => {
  // Pure customer_en is not an AR signal by itself per rules.
  const r = inferDirection({ direction: "付款", customer_en: "PETSOME" });
  assert.equal(r.direction, "AP");
});

test("inferDirection: null/undefined row safe", () => {
  assert.equal(inferDirection(null).direction, "UNCLASSIFIED");
  assert.equal(inferDirection(undefined).direction, "UNCLASSIFIED");
});

// ─────────────────────────────────────────────────────────────────────────────
// pickAmount — fallback chain + parsing
// ─────────────────────────────────────────────────────────────────────────────

test("pickAmount: paid_amount wins", () => {
  const r = pickAmount({ paid_amount: 100, this_amount: 999, amount: 1 });
  assert.equal(r.amountValue, 100);
  assert.equal(r.amountSource, "paid_amount");
  assert.equal(r.parseStatus, "ok");
});

test("pickAmount: this_amount next", () => {
  const r = pickAmount({ paid_amount: null, this_amount: 50 });
  assert.equal(r.amountValue, 50);
  assert.equal(r.amountSource, "this_amount");
});

test("pickAmount: raw.receivedAmount with comma format", () => {
  const r = pickAmount({ raw: { receivedAmount: "1,234.56" } });
  assert.equal(r.amountValue, 1234.56);
  assert.equal(r.amountSource, "raw.receivedAmount");
});

test("pickAmount: raw.receivedAmount with currency prefix → invalid → falls through", () => {
  const r = pickAmount({ raw: { receivedAmount: "¥1234" }, amount: 7 });
  assert.equal(r.amountValue, 7);
  assert.equal(r.amountSource, "amount");
});

test("pickAmount: raw.actualAmount fallback", () => {
  const r = pickAmount({ raw: { actualAmount: "999" } });
  assert.equal(r.amountValue, 999);
  assert.equal(r.amountSource, "raw.actualAmount");
});

test("pickAmount: top-level amount as last numeric fallback", () => {
  const r = pickAmount({ amount: 12.5 });
  assert.equal(r.amountValue, 12.5);
  assert.equal(r.amountSource, "amount");
});

test("pickAmount: pg-returned numeric string handled", () => {
  // pg numeric types come back as strings — ensure we parse them.
  const r = pickAmount({ paid_amount: "21578.34" });
  assert.equal(r.amountValue, 21578.34);
});

test("pickAmount: nothing → missing (no throw)", () => {
  const r = pickAmount({});
  assert.equal(r.amountValue, null);
  assert.equal(r.parseStatus, "missing");
});

test("pickAmount: garbage amount → invalid (no throw)", () => {
  const r = pickAmount({ raw: { receivedAmount: "NOT_A_NUMBER" } });
  assert.equal(r.amountValue, null);
  assert.equal(r.parseStatus, "invalid");
});

test("pickAmount: null row safe", () => {
  const r = pickAmount(null);
  assert.equal(r.parseStatus, "missing");
});

// ─────────────────────────────────────────────────────────────────────────────
// pickPaymentDate — fallback chain
// ─────────────────────────────────────────────────────────────────────────────

test("pickPaymentDate: payment_date wins", () => {
  const r = pickPaymentDate({ payment_date: "2026-03-10", paid_date: "2025-01-01" });
  assert.equal(r.paymentDateValue, "2026-03-10");
  assert.equal(r.paymentDateSource, "payment_date");
});

test("pickPaymentDate: paid_date fallback", () => {
  const r = pickPaymentDate({ payment_date: null, paid_date: "2024-11-22" });
  assert.equal(r.paymentDateValue, "2024-11-22");
  assert.equal(r.paymentDateSource, "paid_date");
});

test("pickPaymentDate: raw.paymentDate fallback", () => {
  const r = pickPaymentDate({ raw: { paymentDate: "2024-02-02" } });
  assert.equal(r.paymentDateSource, "raw.paymentDate");
});

test("pickPaymentDate: raw.paidDate fallback", () => {
  const r = pickPaymentDate({ raw: { paidDate: "2023-09-09" } });
  assert.equal(r.paymentDateSource, "raw.paidDate");
});

test("pickPaymentDate: raw.extractedAt / importedAt explicitly NOT used", () => {
  const r = pickPaymentDate({
    raw: { extractedAt: "2026-01-01", importedAt: "2026-01-02" },
  });
  assert.equal(r.paymentDateValue, null);
  assert.equal(r.parseStatus, "missing");
});

test("pickPaymentDate: ISO timestamp gets sliced to YYYY-MM-DD", () => {
  const r = pickPaymentDate({ payment_date: "2026-03-10T16:00:00.000Z" });
  assert.equal(r.paymentDateValue, "2026-03-10");
});

test("pickPaymentDate: invalid date string → missing", () => {
  const r = pickPaymentDate({ payment_date: "not-a-date" });
  assert.equal(r.parseStatus, "missing");
});

test("pickPaymentDate: null row safe", () => {
  assert.equal(pickPaymentDate(null).parseStatus, "missing");
});

// ─────────────────────────────────────────────────────────────────────────────
// pickMatchKeys — strong / weak / freight + forbidden surface
// ─────────────────────────────────────────────────────────────────────────────

test("pickMatchKeys: strong contract_no FS-style", () => {
  const r = pickMatchKeys({ contract_no: "FS20260220049", order_no: "XM-254" });
  assert.equal(r.strongContractNo, "FS20260220049");
  assert.equal(r.weakOrderNo, "XM-254");
  assert.equal(r.matchStrength, "strong_contract");
});

test("pickMatchKeys: BB / AA legacy contract numbers accepted as strong", () => {
  assert.equal(pickMatchKeys({ contract_no: "BB20231201" }).strongContractNo, "BB20231201");
  assert.equal(pickMatchKeys({ contract_no: "AA20240720" }).strongContractNo, "AA20240720");
  // CN-XXXXX is customers.company_code, NOT finance_payments.contract_no.
  // Confirm the helper does NOT mistake it for a contract:
  assert.equal(pickMatchKeys({ contract_no: "CN-00037"   }).strongContractNo, null);
});

test("pickMatchKeys: non-FS-style contract_no does NOT become strong", () => {
  const r = pickMatchKeys({ contract_no: "lowercase-junk" });
  assert.equal(r.strongContractNo, null);
});

test("pickMatchKeys: weak order_no when no contract_no", () => {
  const r = pickMatchKeys({ order_no: "40-CA-1" });
  assert.equal(r.weakOrderNo, "40-CA-1");
  assert.equal(r.matchStrength, "weak_order");
});

test("pickMatchKeys: multi-order_no (comma) → null weak key", () => {
  const r = pickMatchKeys({ order_no: "XM-254,XM-256,XM-262" });
  assert.equal(r.weakOrderNo, null);
});

test("pickMatchKeys: freight key from raw.blNo", () => {
  const r = pickMatchKeys({ raw: { blNo: "OOLU2322673840" } });
  assert.equal(r.freightBlNo, "OOLU2322673840");
  assert.equal(r.matchStrength, "freight_bl");
});

test("pickMatchKeys: _id surfaced as FORBIDDEN, never canonical", () => {
  const r = pickMatchKeys({ _id: "699c64488723ce35af84605a", contract_no: "" });
  assert.equal(r.forbiddenIds.financePaymentId, "699c64488723ce35af84605a");
  assert.equal(r.strongContractNo, null);
  assert.equal(r.weakOrderNo, null);
  assert.equal(r.matchStrength, "none");
});

test("pickMatchKeys: empty row → all null + matchStrength=none", () => {
  const r = pickMatchKeys({});
  assert.equal(r.matchStrength, "none");
});

// ─────────────────────────────────────────────────────────────────────────────
// SNAPSHOT REPLAY — 386 production rows from dry-run CSV
// ─────────────────────────────────────────────────────────────────────────────

test("snapshot replay: 386 production rows reproduce dry-run classification", async () => {
  const csvUrl  = new URL("./fixtures/finance-payment-classification-dryrun-v1.csv", import.meta.url);
  const csvText = await readFile(csvUrl, "utf8");
  const rows    = readFixture(csvText);

  assert.equal(rows.length, 386, "expect 386 rows in fixture");

  // Per-row diffs
  const dirMismatches    = [];
  const amtSrcMismatches = [];
  const dateSrcMismatches= [];
  const reasonMismatches = [];

  let counts = { AR: 0, AP: 0, UNCLASSIFIED: 0 };
  let byCcy  = {}; // { CCY: { AR: n, AP: n, UNCLASSIFIED: n } }

  // PETSOME R7 audit
  let r7Rows = 0;
  let r7HasAnyApSignal = 0;

  // amount source histogram
  const amtSrcHist = {};
  // date source histogram
  const dateSrcHist = {};

  // matchStrength histogram (helper-side)
  const matchHist = {};

  let unclassifiedNotAttacked = 0; // rows that should stay UNCLASSIFIED

  // Convert CSV string row into helper input row
  function toRowInput(rec) {
    const blRaw = rec.raw_bl_no || null;
    const srcRaw = rec.raw_source || null;
    return {
      _id: null, // not in CSV
      contract_no: rec.contract_no || "",
      order_no:    rec.order_no    || "",
      customer_en: rec.customer_en || "",
      forwarder_cn:rec.forwarder_cn|| "",
      pay_item:    rec.pay_item    || "",
      pay_type:    rec.pay_type    || "",
      direction:   rec.direction_raw || "",
      amount:      null,           // CSV stores computed amount_value, not the raw column —
                                    // for snapshot purposes we don't recompute amount value,
                                    // we just compare amount_source.
      paid_amount: null,
      this_amount: null,
      payment_date: rec.payment_date_value || null,
      paid_date: null,
      currency: rec.currency || null,
      raw: {
        source: srcRaw || undefined,
        blNo:   blRaw  || undefined,
      },
    };
  }

  for (const rec of rows) {
    const input = toRowInput(rec);

    // 1. inferDirection
    const inferred = inferDirection(input);
    counts[inferred.direction] = (counts[inferred.direction] || 0) + 1;
    const ccy = rec.currency || "(null)";
    byCcy[ccy] = byCcy[ccy] || { AR: 0, AP: 0, UNCLASSIFIED: 0 };
    byCcy[ccy][inferred.direction]++;

    if (inferred.direction !== rec.inferred_direction) {
      dirMismatches.push({
        payment_id: rec.payment_id,
        expected:   rec.inferred_direction,
        got:        inferred.direction,
        helper_reason: inferred.reasonCode,
        csv_reason: rec.reason_code,
      });
    }
    if (inferred.reasonCode !== rec.reason_code) {
      reasonMismatches.push({
        payment_id: rec.payment_id,
        expected:   rec.reason_code,
        got:        inferred.reasonCode,
      });
    }

    // PETSOME R7 audit
    if (inferred.reasonCode === "R7_historical_PETSOME") {
      r7Rows++;
      // Check if any AP signal exists in this row
      const hasApSig =
        ["AP", "付款", "out"].includes(input.direction) ||
        (input.pay_item && input.pay_item.indexOf("付") !== -1) ||
        !!input.forwarder_cn ||
        ["拖车费", "报关费", "港杂费", "港杂费用"].includes(input.pay_item);
      if (hasApSig) r7HasAnyApSignal++;
    }

    // UNCLASSIFIED preservation
    if (rec.inferred_direction === "UNCLASSIFIED") {
      if (inferred.direction === "UNCLASSIFIED") unclassifiedNotAttacked++;
    }

    // 2. amount source (we compare source labels only; the actual numeric
    //    value depends on raw-column data not present in this CSV)
    amtSrcHist[rec.amount_source] = (amtSrcHist[rec.amount_source] || 0) + 1;

    // 3. payment date source
    dateSrcHist[rec.payment_date_source] = (dateSrcHist[rec.payment_date_source] || 0) + 1;

    // 4. match keys
    const mk = pickMatchKeys(input);
    matchHist[mk.matchStrength] = (matchHist[mk.matchStrength] || 0) + 1;
  }

  // ── Hard assertions ──
  assert.equal(counts.AR,           327, `AR count mismatch: got ${counts.AR}`);
  assert.equal(counts.AP,            52, `AP count mismatch: got ${counts.AP}`);
  assert.equal(counts.UNCLASSIFIED,   7, `UNCLASSIFIED count mismatch: got ${counts.UNCLASSIFIED}`);

  assert.equal(dirMismatches.length,    0, `direction mismatches: ${JSON.stringify(dirMismatches.slice(0, 5))}`);
  assert.equal(reasonMismatches.length, 0, `reason mismatches: ${JSON.stringify(reasonMismatches.slice(0, 5))}`);

  assert.equal(r7HasAnyApSignal, 0, "R7 PETSOME rows must have ZERO AP signal contamination");
  assert.equal(r7Rows, 183,         `R7 row count should be 183, got ${r7Rows}`);

  // UNCLASSIFIED stability
  assert.equal(unclassifiedNotAttacked, 7, "all 7 UNCLASSIFIED rows must stay UNCLASSIFIED");

  // ── Soft prints (visible with --test-reporter=spec) ──
  console.log("[snapshot] counts:", counts);
  console.log("[snapshot] by currency:", byCcy);
  console.log("[snapshot] amount source histogram:", amtSrcHist);
  console.log("[snapshot] date   source histogram:", dateSrcHist);
  console.log("[snapshot] match strength histogram:", matchHist);
  console.log("[snapshot] PETSOME R7 rows:", r7Rows, "AP-contaminated:", r7HasAnyApSignal);
});
