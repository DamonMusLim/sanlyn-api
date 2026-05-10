import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js"; // S18.1: handler-level auth guard
import { sendShipmentNotifications } from "../../jobs/shipment-notify.js";

// Normalize a Chinese company name for matching:
//  - strip full/half-width brackets, spaces, punctuation
//  - drop leading geo prefix (厦门/上海/天津/…)
//  - drop generic corporate suffixes (有限公司/有限责任公司/股份有限公司/分公司)
// So e.g. both "万汇国际（厦门）" and "万汇国际厦门有限公司" → "万汇国际"
// while "万汇恒通(厦门)国际物流有限公司" → "万汇恒通国际物流" (distinct!)
function normCompany(s) {
  if (!s) return "";
  let x = String(s).replace(/[（）()【】\[\]\s、，,。.·\-_/\\]/g, "");
  const geo = ["厦门","上海","天津","青岛","宁波","深圳","山东","江苏","烟台","福建","广州"];
  for (const g of geo) if (x.startsWith(g) && x.length > g.length + 1) { x = x.slice(g.length); break; }
  x = x.replace(/(股份有限公司|有限责任公司|有限公司|分公司)$/g, "");
  return x;
}

const PATCH_ALLOW = [
  "bl_no","vessel","voyage","pol","pod","etd","eta","cutoff_date",
  "flow_status","container_type","container_no","seal_no",
  "qty_total","total_cbm","total_cartons","gross_weight_kg",
  "freight_cost","freight_sale_usd","port_surcharge_total",
  "bkg_fee","doc_fee","tlx_fee","thc_fee","eir_fee","seal_fee","vgm_fee","customs_declare_fee",
  "customs_cost_total","trucking_cost_total","agency_fee_rmb",
  "forwarder_cn","customs_cn","trucking_cn","shipper","consignee",
  "cargo_description","product_notes","release_type",
  "order_contract_nos","contract_no","shipment_no","forwarder_booking_no","booking_sent_at","collab_sheet_status",
  "notes","status","current_status","current_status_cn",
  // driver + insurance (added 2026-05-09)
  "driver_info","insurance_required","insurance_premium","insurance_policy_no","insurance_rate",
];

export default async function handler(req, res) {
  setCors(req, res, "GET, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return; // S18.1: 401 if no valid JWT

  const pool = getPool();

  // ── PATCH ─────────────────────────────────────────────────
  if (req.method === "PATCH") {
    const { id, ...fields } = req.body || {};
    if (!id) return res.status(400).json({ error: "id required" });

    // Fetch existing row first (for bl_no change detection)
    let existing = null;
    try {
      const ex = await pool.query("SELECT * FROM shipping_plans WHERE id = $1", [id]);
      existing = ex.rows[0] || null;
    } catch (e) {
      return res.status(500).json({ error: "fetch existing: " + e.message });
    }
    if (!existing) return res.status(404).json({ error: "row not found" });

    const sets = [];
    const vals = [];
    PATCH_ALLOW.forEach(k => {
      if (k in fields) {
        vals.push(fields[k]);
        sets.push(`${k} = $${vals.length}`);
      }
    });
    // Merge first_issued_at JSONB (per-docType timestamps)
    if (fields.first_issued_at && typeof fields.first_issued_at === "object") {
      vals.push(JSON.stringify(fields.first_issued_at));
      sets.push(`first_issued_at = COALESCE(first_issued_at,'{}') || $${vals.length}::jsonb`);
    }
    if (!sets.length) return res.status(400).json({ error: "no updatable fields" });
    vals.push(id);
    const sql = `UPDATE shipping_plans SET ${sets.join(", ")}, updated_at = now() WHERE id = $${vals.length} RETURNING *`;

    let saved;
    try {
      const r = await pool.query(sql, vals);
      saved = r.rows[0];
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }

    // ── bl_no change detection → trigger dual notifications ──
    const prevBl = existing.bl_no;
    const newBl  = saved.bl_no;
    let notifyResult = null;
    if (!prevBl && newBl) {
      try {
        notifyResult = await sendShipmentNotifications(pool, saved);
      } catch (e) {
        console.error("[shipping] notify failed (non-fatal):", e.message);
        notifyResult = { error: e.message };
      }
    }

    return res.status(200).json({
      success: true,
      data: saved,
      ...(notifyResult ? { notified: notifyResult } : {}),
    });
  }

  // ── GET ───────────────────────────────────────────────────
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { customer, created_by, limit = 500 } = req.query;
    let query = "SELECT * FROM shipping_plans", params = [], conds = [];
    if (customer) { params.push(`%${customer}%`); conds.push(`customer ILIKE $${params.length}`); }
    if (created_by) { params.push(created_by); conds.push(`created_by = $${params.length}`); }

    // ── Vendor data scoping: logistics users see ONLY their own shipments ──
    const u = req.user || {};
    let scopeCol = null, scopeNeedle = "";
    if (u.role === "logistics") {
      scopeCol = u.supplierRole === "ocean" ? "forwarder_cn"
              : u.supplierRole === "customs" ? "customs_cn"
              : u.supplierRole === "truck"   ? "trucking_cn"
              : null;
      scopeNeedle = normCompany(u.company);
      if (!scopeCol || !scopeNeedle) {
        return res.status(200).json({ success: true, data: [], count: 0, scoped: "logistics:empty" });
      }
      const hint = scopeNeedle.slice(0, 2);
      params.push(`%${hint}%`);
      conds.push(`${scopeCol} ILIKE $${params.length}`);
    }

    if (conds.length) query += " WHERE " + conds.join(" AND ");
    params.push(parseInt(limit));
    query += ` ORDER BY etd DESC LIMIT $${params.length}`;
    let rows = (await pool.query(query, params)).rows;

    if (scopeCol && scopeNeedle) {
      rows = rows.filter(r => {
        const cell = normCompany(r[scopeCol]);
        return cell && (cell.includes(scopeNeedle) || scopeNeedle.includes(cell));
      });
    }
    return res.status(200).json({ success: true, data: rows, count: rows.length });
  } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
}
