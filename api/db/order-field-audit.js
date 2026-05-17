// /api/db/order-field-audit
// ─────────────────────────────────────────────────────────────────────────────
// Read-only data-quality scan over the orders table. Returns every order with
// the CRITICAL_FIELDS list and per-field status (ok | missing | suspect) plus
// the raw value so the admin Data Quality Console can render a JDY-style sheet
// and operators can spot bad rows without us flagging each one manually.
//
// GET /api/db/order-field-audit
//   ?status=missing|all   default 'missing' (only rows that need attention)
//   ?factory=FX           filter by raw.factoryCode / first 2 chars of contract
//   ?company=CN-00037     filter by company_code
//   ?limit=200            default 500
//
// Response:
//   {
//     ok: true,
//     summary: { total_scanned, total_missing, by_field: { containerType: 23, ... } },
//     rows: [{
//       contract_no, customer_po, company_code, company_name,
//       factory_code, factory_name, created_at,
//       fields: {
//         containerType: { status:'ok'|'missing'|'suspect', value:'40hq' },
//         containerQty:  { ... },
//         ...
//       },
//       missing_count: 3
//     }]
//   }
//
// Admin / super_admin / finance / logistics only — non-internal callers 403.
import { getPool, setCors } from "../db.js";

const INTERNAL_ROLES = new Set(["admin", "super_admin", "finance", "logistics", "internal_ops"]);

// Add new must-have fields here — the Console picks them up automatically.
// `path` is the JSONB key under orders.raw (or a top-level orders column when
// `column` is set). `label` is what the Console displays in the column header.
// Field-source cascade. Each field tries sources in order; first non-empty wins.
// Honors the "never invent" rule: only reads from existing real columns, no fabricated defaults.
// Source format: { col?, json?, derive? } where derive() takes the joined row.
//   col   → top-level column on orders (joined row)
//   json  → key in orders.raw JSONB
//   sp    → top-level column on joined shipping_plans
//   cust  → top-level column on joined customers
const CRITICAL_FIELDS = [
  { key: "containerType", label: "Container Type", sources: [{ json: "containerType" }] },
  { key: "containerQty",  label: "Container Qty",  sources: [{ json: "containerQty"  }] },
  { key: "totalBoxes",    label: "Total Boxes",    sources: [{ json: "totalBoxes"    }] },
  { key: "grossWeight",   label: "Gross Weight",   sources: [{ json: "grossWeight"   }] },
  { key: "deliveryDate",  label: "Delivery Date",  sources: [{ json: "deliveryDate"  }] },
  // Incoterm cascade: top-level column → raw camelCase → customer default
  { key: "incoterm",      label: "Incoterm",       sources: [{ col: "trade_terms" }, { json: "tradeTerms" }, { json: "incoterm" }, { cust: "trade_terms" }] },
  // Shipper = seller. We are the seller; pulled from issuing_company → companies table later.
  // For now: raw.shipperCompany only. If empty, audit flags it — operator fills in DQ Console.
  { key: "shipperCompany",label: "Shipper",        sources: [{ json: "shipperCompany" }, { json: "shipper" }] },
  // Consignee cascade: raw → customer name (buyer = consignee in standard FOB)
  { key: "consignee",     label: "Consignee",      sources: [{ json: "consignee" }, { cust: "name_en" }, { cust: "name_cn" }] },
  // ── 2026-05-18 new joined fields ──
  { key: "freightTerm",   label: "Freight Term",   sources: [{ sp: "freight_term" }] },
  { key: "quoteRef",      label: "Quote Ref",      sources: [{ sp: "quote_ref" }] },
  { key: "uscc",          label: "USCC",           sources: [{ cust: "uscc" }, { cust: "tax_no" }] },
];

// Resolve first non-empty value through the cascade. Returns { value, sourceTag }.
// sourceTag tells the UI where the value came from (e.g. "col:trade_terms" or "cust:name_en")
// so admin can spot "this came from customer default, not order-specific" cases.
function resolveField(field, joinedRow) {
  const raw = (joinedRow.raw && typeof joinedRow.raw === "object") ? joinedRow.raw : {};
  for (const src of field.sources) {
    let v;
    let tag;
    if (src.col)       { v = joinedRow[src.col];           tag = "col:"  + src.col; }
    else if (src.json) { v = raw[src.json];                tag = "json:" + src.json; }
    else if (src.sp)   { v = joinedRow["__sp_" + src.sp];  tag = "sp:"   + src.sp; }
    else if (src.cust) { v = joinedRow["__c_"  + src.cust]; tag = "cust:" + src.cust; }
    if (v != null && !(typeof v === "string" && v.trim() === "") && v !== 0) return { value: v, sourceTag: tag };
  }
  return { value: null, sourceTag: null };
}

function isBlank(v) {
  if (v == null) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  if (typeof v === "number" && v === 0) return true;
  return false;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")     return res.status(405).json({ error: "GET only" });
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (!INTERNAL_ROLES.has(req.user.role)) {
    return res.status(403).json({ error: "internal_only" });
  }

  const pool = getPool();
  const status  = String(req.query?.status  || "missing").toLowerCase();
  const factory = req.query?.factory || null;
  const company = req.query?.company || null;
  const limit   = Math.min(parseInt(req.query?.limit || "500", 10) || 500, 2000);

  const conds = [];
  const params = [];
  if (factory) { params.push(factory); conds.push("raw->>'factoryCode' = $" + params.length); }
  if (company) { params.push(company); conds.push("company_code = $" + params.length); }

  const where = conds.length ? "WHERE " + conds.map(c => c.replace(/raw->>/g, "o.raw->>").replace(/company_code/g, "o.company_code")).join(" AND ") : "";
  // LEFT JOIN shipping_plans (by contract_no) + customers (by company_code).
  // Joined columns aliased with __sp_ / __c_ prefix so resolveField() can find them without collision.
  const sql =
    "SELECT o.id, o.contract_no, o.customer_po, o.company_code, o.created_at, " +
    "       o.trade_terms, " +
    "       o.raw->>'companyName' AS company_name, " +
    "       o.raw->>'factoryCode' AS factory_code, " +
    "       o.raw->>'factoryName' AS factory_name, " +
    "       o.raw, " +
    "       sp.freight_term AS __sp_freight_term, " +
    "       sp.quote_ref    AS __sp_quote_ref, " +
    "       c.uscc          AS __c_uscc, " +
    "       c.tax_no        AS __c_tax_no, " +
    "       c.name_en       AS __c_name_en, " +
    "       c.name_cn       AS __c_name_cn, " +
    "       c.trade_terms   AS __c_trade_terms " +
    "  FROM orders o " +
    "  LEFT JOIN shipping_plans sp ON sp.contract_no = o.contract_no " +
    "  LEFT JOIN customers c ON c.company_code = o.company_code " +
    where +
    " ORDER BY o.created_at DESC NULLS LAST " +
    " LIMIT " + limit;

  let result;
  try { result = await pool.query(sql, params); }
  catch (err) { return res.status(500).json({ error: err.message }); }

  const byField = {};
  CRITICAL_FIELDS.forEach(f => { byField[f.key] = 0; });
  let totalMissing = 0;

  const rows = result.rows.map(r => {
    const raw = (r.raw && typeof r.raw === "object") ? r.raw : {};
    const fields = {};
    let rowMissing = 0;
    CRITICAL_FIELDS.forEach(f => {
      const { value, sourceTag } = resolveField(f, r);
      const blank = value == null;
      if (blank) { byField[f.key] += 1; rowMissing += 1; }
      // Returns the resolved value + which source provided it (e.g. 'col:trade_terms' vs 'json:tradeTerms')
      // so DQ Console can show a small "via customer default" hint when relevant.
      fields[f.key] = { status: blank ? "missing" : "ok", value: blank ? null : value, source: sourceTag };
    });
    if (rowMissing > 0) totalMissing += 1;
    return {
      id:           r.id,
      contract_no:  r.contract_no,
      customer_po:  r.customer_po,
      company_code: r.company_code,
      company_name: r.company_name || null,
      factory_code: r.factory_code || null,
      factory_name: r.factory_name || null,
      created_at:   r.created_at,
      fields,
      missing_count: rowMissing,
    };
  });

  const filtered = status === "missing"
    ? rows.filter(r => r.missing_count > 0)
    : rows;

  return res.status(200).json({
    ok: true,
    summary: {
      total_scanned: rows.length,
      total_with_gaps: totalMissing,
      by_field: byField,
    },
    fields: CRITICAL_FIELDS.map(f => ({ key: f.key, label: f.label, sources: f.sources, editable: f.sources[0] && !!f.sources[0].json })),
    rows: filtered,
  });
}
