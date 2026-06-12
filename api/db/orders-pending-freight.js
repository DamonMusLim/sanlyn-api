import { getPool, setCors } from "../db.js";
import { roleFromAuth, sendError } from "../lib/viewmodel-adapter.js";

// GET /api/db/orders-pending-freight
// Orders that are ready/confirmed but have no freight RFQ yet.
// These need to be quoted before booking can start.
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.end();

  const pool = getPool();
  const role = await roleFromAuth(req);
  if (!role) return sendError(res, 401, "Unauthorized");

  try {
    const { rows } = await pool.query(`
      SELECT
        o.id              AS order_id,
        o.order_no,
        o.contract_no,
        o.status          AS order_status,
        o.etd             AS order_etd,
        o.customer,
        sp.id             AS plan_id,
        sp.vessel,
        sp.voyage,
        sp.etd            AS plan_etd,
        sp.pol,
        sp.pod,
        sp.carrier_code,
        sp.collab_sheet_status,
        sp.flow_status,
        (SELECT COUNT(*) FROM freight_rfqs fr WHERE fr.order_id = o.id) AS rfq_count,
        (SELECT COUNT(*) FROM freight_rfq_items fri
           JOIN freight_rfqs fr ON fr.id = fri.rfq_id
           WHERE fr.order_id = o.id) AS quote_submissions
      FROM orders o
      LEFT JOIN shipping_plans sp ON sp.contract_no = o.contract_no
      WHERE o.status IN ('confirmed', 'ready', 'ready_to_ship', 'in_progress')
      ORDER BY
        CASE o.status
          WHEN 'ready_to_ship' THEN 1
          WHEN 'ready'         THEN 2
          WHEN 'confirmed'     THEN 3
          ELSE 4
        END,
        COALESCE(sp.etd, o.etd) ASC NULLS LAST,
        o.created_at DESC
    `);

    const data = rows.map(r => ({
      order_id:         r.order_id,
      order_no:         r.order_no,
      contract_no:      r.contract_no,
      order_status:     r.order_status,
      etd:              r.plan_etd || r.order_etd || null,
      customer:         r.customer || "—",
      plan_id:          r.plan_id || null,
      vessel:           r.vessel || null,
      voyage:           r.voyage || null,
      pol:              r.pol || null,
      pod:              r.pod || null,
      carrier_code:     r.carrier_code || null,
      collab_sheet_status: r.collab_sheet_status || null,
      rfq_count:        Number(r.rfq_count),
      quote_submissions: Number(r.quote_submissions),
      has_plan:         !!r.plan_id,
      needs_quote:      Number(r.rfq_count) === 0,
    }));

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ success: true, data, total: data.length }));
  } catch (err) {
    console.error("[orders-pending-freight] error:", err.message);
    sendError(res, 500, err.message);
  }
}
