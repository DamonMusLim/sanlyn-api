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
import { getPool, setCors } from "./db.js";

const INTERNAL_ROLES = new Set(["admin", "super_admin", "finance", "logistics", "internal_ops"]);

// Add new must-have fields here — the Console picks them up automatically.
// `path` is the JSONB key under orders.raw (or a top-level orders column when
// `column` is set). `label` is what the Console displays in the column header.
const CRITICAL_FIELDS = [
  { key: "containerType", label: "Container Type", path: "containerType" },
  { key: "containerQty",  label: "Container Qty",  path: "containerQty"  },
  { key: "totalBoxes",    label: "Total Boxes",    path: "totalBoxes"    },
  { key: "grossWeight",   label: "Gross Weight",   path: "grossWeight"   },
  { key: "deliveryDate",  label: "Delivery Date",  path: "deliveryDate"  },
  { key: "incoterm",      label: "Incoterm",       path: "incoterm"      },
  { key: "shipperCompany",label: "Shipper",        path: "shipperCompany"},
  { key: "consignee",     label: "Consignee",      path: "consignee"     },
];

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

  const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
  const sql =
    "SELECT id, contract_no, customer_po, company_code, created_at, " +
    "       raw->>'companyName' AS company_name, " +
    "       raw->>'factoryCode' AS factory_code, " +
    "       raw->>'factoryName' AS factory_name, " +
    "       raw " +
    "  FROM orders " + where +
    " ORDER BY created_at DESC NULLS LAST " +
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
      const value = raw[f.path];
      const blank = isBlank(value);
      if (blank) { byField[f.key] += 1; rowMissing += 1; }
      fields[f.key] = { status: blank ? "missing" : "ok", value: blank ? null : value };
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
    fields: CRITICAL_FIELDS.map(f => ({ key: f.key, label: f.label, path: f.path })),
    rows: filtered,
  });
}
