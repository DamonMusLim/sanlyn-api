import { getPool, setCors } from "../db.js";
import { bad, requireFinance } from "./bill-center-auth.js";

function feeLines(fees) {
  if (!fees) return [];
  if (Array.isArray(fees)) return fees;
  if (typeof fees === "object") {
    return Object.entries(fees).map(([name, value]) => (
      value && typeof value === "object" ? { name, ...value } : { name, amount: value }
    ));
  }
  return [];
}

export async function getEstimates(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (!requireFinance(req, res)) return;
  const blNo = String(req.query.bl_no || "").trim();
  if (!blNo) return bad(res, 400, "missing_bl_no", "bl_no required");

  const pool = getPool();
  const plan = await pool.query(
    `SELECT id, bl_no, pol, pod, carrier_code, shipping_line, container_type, container_qty, etd
       FROM shipping_plans
      WHERE bl_no = $1 OR hbl_no = $1
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 1`,
    [blNo]
  );
  if (!plan.rows.length) return res.status(200).json({ success: true, data: [] });
  const sp = plan.rows[0];
  const charges = await pool.query(
    `SELECT carrier, pol, pod, company_name, container_type, fees, cost_total, sell_total,
            charge_code, effective_from, currency, amount, charge_name, charge_type, created_at
       FROM local_charges
      WHERE ($1::text IS NULL OR carrier = $1 OR carrier = $2)
        AND ($3::text IS NULL OR pol = $3)
        AND ($4::text IS NULL OR pod = $4)
        AND ($5::text IS NULL OR container_type = $5)
        AND (effective_from IS NULL OR effective_from <= COALESCE($6::date, CURRENT_DATE))
      ORDER BY effective_from DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT 5`,
    [sp.shipping_line || null, sp.carrier_code || null, sp.pol || null, sp.pod || null, sp.container_type || null, sp.etd || null]
  );
  const data = charges.rows.map((c) => ({
    ...c,
    bl_no: sp.bl_no,
    shipping_plan_id: sp.id,
    qty: sp.container_qty,
    fee_lines: feeLines(c.fees),
    is_estimate: true,
    source: "history",
    included_in_total: false,
    invoice_allowed: false,
  }));
  return res.status(200).json({ success: true, data });
}
