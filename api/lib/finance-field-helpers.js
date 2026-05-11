// api/lib/finance-field-helpers.js
//
// Pure functions for finance field normalization.
// Spec: docs/workstreams/2026-05-finance-mainline/finance-helper-rules-v1.md
//       docs/workstreams/2026-05-finance-mainline/finance-viewmodel-contract-v1.md
//
// Status: helper library only — NOT wired into any API handler in this task.
//         FIN-DATA-API-ADAPTER-004 will integrate them.
//
// All functions are pure: same input → same output, no I/O, no side effects.
// All return well-formed shapes even when input is malformed (never throw).

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (internal)
// ─────────────────────────────────────────────────────────────────────────────

/** Read a field from a flat row OR row.raw (string-keyed JSON). */
function getRaw(row, key) {
  if (!row) return null;
  const raw = row.raw;
  if (raw == null) return null;
  // raw may already be an object (pg jsonb), or a string we must parse.
  if (typeof raw === "string") {
    try {
      const obj = JSON.parse(raw);
      return obj?.[key] ?? null;
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") return raw[key] ?? null;
  return null;
}

/** Trim + treat empty string as null. */
function nz(value) {
  if (value == null) return null;
  if (typeof value !== "string") return value;
  const t = value.trim();
  return t === "" ? null : t;
}

/** True iff string contains the substring (Chinese-safe). */
function contains(haystack, needle) {
  if (!haystack || !needle) return false;
  return String(haystack).indexOf(needle) !== -1;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. inferDirection(row) — AR / AP / UNCLASSIFIED
// Rule priority (first match wins): see finance-helper-rules-v1.md §1
// ─────────────────────────────────────────────────────────────────────────────

const DIR_AP_EXPLICIT = new Set(["AP", "付款", "out"]);
const DIR_AR_EXPLICIT = new Set(["AR", "收款", "in"]);
const PAY_ITEM_AR_GOODS = new Set(["goods", "货款", "全款"]);
const PAY_ITEM_AP_COST  = new Set(["拖车费", "报关费", "港杂费", "港杂费用"]);
const PAY_ITEM_FREIGHT  = new Set(["freight", "运费", "海运费", "海运费用"]);

export function inferDirection(row) {
  if (!row) {
    return { direction: "UNCLASSIFIED", confidence: "low", reasonCode: "R0_no_signal", signals: [] };
  }
  const direction   = nz(row.direction);
  const payItem     = nz(row.pay_item);
  const forwarderCn = nz(row.forwarder_cn);
  const customerEn  = nz(row.customer_en);
  const rawSource   = nz(getRaw(row, "source"));

  const signals = [];
  if (direction)   signals.push(`direction=${direction}`);
  if (payItem)     signals.push(`pay_item=${payItem}`);
  if (forwarderCn) signals.push("forwarder_cn_set");
  if (customerEn)  signals.push("customer_en_set");
  if (rawSource)   signals.push(`raw.source=${rawSource}`);

  // ── AP strong signals FIRST (R1–R4) ────────────────────────────
  if (direction && DIR_AP_EXPLICIT.has(direction)) {
    return { direction: "AP", confidence: "high", reasonCode: "R1_dir_AP_explicit", signals };
  }
  if (payItem && contains(payItem, "付")) {
    return { direction: "AP", confidence: "high", reasonCode: "R2_pay_item_contains_pay", signals };
  }
  if (forwarderCn) {
    return { direction: "AP", confidence: "high", reasonCode: "R3_forwarder_cn_set", signals };
  }
  if (payItem && PAY_ITEM_AP_COST.has(payItem)) {
    return { direction: "AP", confidence: "high", reasonCode: "R4_pay_item_cost_AP", signals };
  }

  // ── AR signals (R5–R7) ─────────────────────────────────────────
  if (direction && DIR_AR_EXPLICIT.has(direction)) {
    return { direction: "AR", confidence: "high", reasonCode: "R5_dir_AR_explicit", signals };
  }
  if (payItem && PAY_ITEM_AR_GOODS.has(payItem)) {
    return { direction: "AR", confidence: "high", reasonCode: "R6_pay_item_goods_AR", signals };
  }
  if (rawSource === "historical_orders_to_import.json" && customerEn === "PETSOME SDN BHD") {
    return { direction: "AR", confidence: "medium", reasonCode: "R7_historical_PETSOME", signals };
  }

  // ── Freight disambiguation (R8 / R9) ───────────────────────────
  if (payItem && PAY_ITEM_FREIGHT.has(payItem)) {
    if (forwarderCn) {
      // Already covered by R3, but kept as belt-and-suspenders.
      return { direction: "AP", confidence: "medium", reasonCode: "R8_freight_to_forwarder_AP", signals };
    }
    if (customerEn) {
      return { direction: "AR", confidence: "medium", reasonCode: "R9_freight_from_customer_AR", signals };
    }
  }

  // ── No signal ──────────────────────────────────────────────────
  return { direction: "UNCLASSIFIED", confidence: "low", reasonCode: "R0_no_signal", signals };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. pickAmount(row) — fallback chain with safe numeric parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse an importer-controlled raw string into a number.
 *  - Strips [, ] (comma + space): '1,234.00' → '1234.00'
 *  - Returns { ok: true, value } only if the stripped form matches /^-?\d+(\.\d+)?$/.
 *  - Otherwise { ok: false }.
 *
 * Mirrors SQL CASE used in finance_payments summary query.
 */
function parseRawNumeric(raw) {
  if (raw == null) return { ok: false };
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? { ok: true, value: raw } : { ok: false };
  }
  if (typeof raw !== "string") return { ok: false };
  const stripped = raw.replace(/[, ]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(stripped)) return { ok: false };
  const n = parseFloat(stripped);
  return Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
}

/**
 * Convert any candidate column value to a finite number, or null.
 * Handles strings with commas the same way as raw JSON.
 */
function toFiniteOrNull(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const p = parseRawNumeric(v);
    return p.ok ? p.value : null;
  }
  // numeric-like (pg numeric types come back as strings, handled above)
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function pickAmount(row) {
  if (!row) {
    return { amountValue: null, amountSource: null, parseStatus: "missing" };
  }

  // 1. paid_amount (numeric column)
  let v = toFiniteOrNull(row.paid_amount);
  if (v != null) return { amountValue: v, amountSource: "paid_amount", parseStatus: "ok" };

  // 2. this_amount (numeric column)
  v = toFiniteOrNull(row.this_amount);
  if (v != null) return { amountValue: v, amountSource: "this_amount", parseStatus: "ok" };

  // 3. raw.receivedAmount (importer JSON; may be formatted)
  {
    const r = parseRawNumeric(getRaw(row, "receivedAmount"));
    if (r.ok) {
      const wasString = typeof getRaw(row, "receivedAmount") === "string";
      return {
        amountValue:  r.value,
        amountSource: "raw.receivedAmount",
        parseStatus:  wasString ? "ok" : "ok",
      };
    }
  }

  // 4. raw.actualAmount
  {
    const r = parseRawNumeric(getRaw(row, "actualAmount"));
    if (r.ok) {
      return { amountValue: r.value, amountSource: "raw.actualAmount", parseStatus: "ok" };
    }
  }

  // 5. amount (top-level legacy column)
  v = toFiniteOrNull(row.amount);
  if (v != null) return { amountValue: v, amountSource: "amount", parseStatus: "ok" };

  // 6. Was anything present but unparseable? → invalid
  const candidateRaw = getRaw(row, "receivedAmount") ?? getRaw(row, "actualAmount") ?? row.amount;
  if (candidateRaw != null && candidateRaw !== "") {
    return { amountValue: null, amountSource: null, parseStatus: "invalid" };
  }
  return { amountValue: null, amountSource: null, parseStatus: "missing" };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. pickPaymentDate(row) — payment_date / paid_date / raw.{paid,payment}Date
// ─────────────────────────────────────────────────────────────────────────────

const ISO_DATE_RX = /^\d{4}-\d{2}-\d{2}/;

function toISODate(v) {
  if (v == null) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === "string") {
    if (!ISO_DATE_RX.test(v)) return null;
    return v.slice(0, 10);
  }
  return null;
}

export function pickPaymentDate(row) {
  if (!row) {
    return { paymentDateValue: null, paymentDateSource: null, parseStatus: "missing" };
  }

  // 1. payment_date (canonical column)
  {
    const d = toISODate(row.payment_date);
    if (d) return { paymentDateValue: d, paymentDateSource: "payment_date", parseStatus: "ok" };
  }

  // 2. paid_date (legacy column)
  {
    const d = toISODate(row.paid_date);
    if (d) return { paymentDateValue: d, paymentDateSource: "paid_date", parseStatus: "ok" };
  }

  // 3. raw.paymentDate
  {
    const d = toISODate(getRaw(row, "paymentDate"));
    if (d) return { paymentDateValue: d, paymentDateSource: "raw.paymentDate", parseStatus: "ok" };
  }

  // 4. raw.paidDate
  {
    const d = toISODate(getRaw(row, "paidDate"));
    if (d) return { paymentDateValue: d, paymentDateSource: "raw.paidDate", parseStatus: "ok" };
  }

  // NOTE: raw.extractedAt / raw.importedAt are METADATA, never real
  // payment dates. They are intentionally NOT in the fallback chain.
  // Callers wanting a metadata-derived display date should request it
  // explicitly via a separate helper (not provided in -003).

  return { paymentDateValue: null, paymentDateSource: null, parseStatus: "missing" };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. pickMatchKeys(row) — canonical join-key resolver
// ─────────────────────────────────────────────────────────────────────────────

// FS-style contract number: 2–4 uppercase letters then 6+ digits.
// Matches FS20260220049, BB20231201, AA20240720, CN-00001, etc.
// Conservative: anything that doesn't fit is rejected as the strong key.
const FS_STYLE_RX = /^[A-Z]{2,4}[-]?\d{6,}/;

function normalizeOrderNo(value) {
  if (value == null) return null;
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (t === "") return null;
  if (t.indexOf(",") !== -1) return null; // multi-order — see helper rules §4 Note 1
  return t;
}

export function pickMatchKeys(row) {
  const result = {
    strongContractNo: null,
    weakOrderNo:      null,
    freightBlNo:      null,
    forbiddenIds: {
      financePaymentId: null,
      orderId:          null,
    },
    matchStrength: "none",
  };
  if (!row) return result;

  // Always record the forbidden keys so callers can audit what they
  // would NEVER use:
  result.forbiddenIds.financePaymentId = nz(row._id) ?? null;
  result.forbiddenIds.orderId          = nz(row.order_id) ?? null; // never set canonically

  // Strong key: contract_no, FS-style only.
  const cno = nz(row.contract_no);
  if (cno && FS_STYLE_RX.test(cno)) {
    result.strongContractNo = cno;
    result.matchStrength = "strong_contract";
    // Continue: weak/freight keys are still useful as hints for the
    // adapter layer (e.g., to log when both contract_no and bl_no
    // disagree).
  }

  // Weak key: order_no, single-order only, no commas.
  const ono = normalizeOrderNo(row.order_no);
  if (ono) {
    result.weakOrderNo = ono;
    if (result.matchStrength === "none") result.matchStrength = "weak_order";
  }

  // Freight key: raw.blNo / raw.bl_no (camelCase preferred).
  const bl = nz(getRaw(row, "blNo")) ?? nz(getRaw(row, "bl_no"));
  if (bl) {
    result.freightBlNo = bl;
    if (result.matchStrength === "none") result.matchStrength = "freight_bl";
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience: combined classification for snapshot replay tests.
// ─────────────────────────────────────────────────────────────────────────────

export function classifyPaymentRow(row) {
  return {
    direction:    inferDirection(row),
    amount:       pickAmount(row),
    paymentDate:  pickPaymentDate(row),
    matchKeys:    pickMatchKeys(row),
  };
}
