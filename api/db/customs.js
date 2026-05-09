// sanlyn-api/api/db/customs.js
// GET  /api/db/customs                → 全部 (with orders JOIN for order context)
// GET  /api/db/customs?contract=xxx   → 按合同号过滤
// GET  /api/db/customs?shipment=xxx   → 按出运编号过滤
// GET  /api/db/customs?order_no=xxx   → 按订单号过滤
// PATCH /api/db/customs               → 更新记录 (requires id)
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const PATCH_ALLOW = [
  "order_no","contract_no","shipment_no","status","trade_terms",
  "declaration_date","declared_value","currency","hs_code","entry_type",
  "customs_notes","notes","total_amount","factory_city","port",
  // insurance (added 2026-05-09)
  "insured","insurance_rate","insurance_policy_no","insurance_premium",
];

export default async function handler(req, res) {
  setCors(req, res, "GET, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const pool = getPool();

  // ── PATCH ─────────────────────────────────────────────────
  if (req.method === "PATCH") {
    const { id, ...fields } = req.body || {};
    if (!id) return res.status(400).json({ error: "id required" });

    const sets = [];
    const vals = [];
    PATCH_ALLOW.forEach(k => {
      if (k in fields) {
        vals.push(fields[k]);
        sets.push(`${k} = $${vals.length}`);
      }
    });
    if (!sets.length) return res.status(400).json({ error: "no updatable fields" });
    vals.push(id);
    const sql = `UPDATE customs_data SET ${sets.join(", ")}, updated_at = now() WHERE _id = $${vals.length} RETURNING *`;
    try {
      const r = await pool.query(sql, vals);
      return res.status(200).json({ success: true, data: r.rows[0] });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── GET ───────────────────────────────────────────────────
  if (req.method !== "GET") return res.status(405).json({ error: "GET or PATCH only" });

  try {
    const { contract, shipment, order_no, id } = req.query;

    // Full list query: LEFT JOIN orders for context columns
    const conds = [];
    const vals  = [];

    if (id) {
      conds.push(`c._id = $${vals.length + 1}`);
      vals.push(id);
    }
    if (contract) {
      conds.push(`c.contract_no = $${vals.length + 1}`);
      vals.push(contract);
    }
    if (shipment) {
      conds.push(`c.shipment_no = $${vals.length + 1}`);
      vals.push(shipment);
    }
    if (order_no) {
      conds.push(`c.order_no = $${vals.length + 1}`);
      vals.push(order_no);
    }

    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

    const sql = `
      SELECT
        c.*,
        o.id            AS order_id,
        o.customer      AS order_customer,
        o.status        AS order_status,
        o.total_amount  AS order_amount,
        o.bl_no         AS order_bl_no,
        o.trade_terms   AS order_trade_terms,
        o.currency      AS order_currency,
        o.etd           AS order_etd,
        o.seller_code   AS order_seller_code,
        o.raw->>'factory' AS order_factory
      FROM customs_data c
      LEFT JOIN orders o
        ON  (c.order_no    IS NOT NULL AND c.order_no    != '' AND o.contract_no = c.order_no)
         OR (c.order_no    IS NOT NULL AND c.order_no    != '' AND o.order_no    = c.order_no)
         OR (c.contract_no IS NOT NULL AND c.contract_no != '' AND o.contract_no = c.contract_no
             AND (c.order_no IS NULL OR c.order_no = ''))
      ${where}
      ORDER BY c.updated_at DESC
    `;

    const result = await pool.query(sql, vals);
    return res.status(200).json({ success: true, data: result.rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
