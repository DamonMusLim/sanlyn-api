// /api/db/diag-shipping.js — Diagnostic: show forwarderCN values in shipping_plans
import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const pool = getPool();

    // 1. All unique forwarderCN values
    const fwd = await pool.query(`
      SELECT raw->>'forwarderCN' as forwarder_cn, COUNT(*) as cnt
      FROM shipping_plans
      GROUP BY raw->>'forwarderCN'
      ORDER BY cnt DESC
    `);

    // 2. All unique shippingLine values
    const sl = await pool.query(`
      SELECT raw->>'shippingLine' as shipping_line, COUNT(*) as cnt
      FROM shipping_plans
      GROUP BY raw->>'shippingLine'
      ORDER BY cnt DESC
    `);

    // 3. All unique truckingCN values
    const tk = await pool.query(`
      SELECT raw->>'truckingCN' as trucking_cn, COUNT(*) as cnt
      FROM shipping_plans
      GROUP BY raw->>'truckingCN'
      ORDER BY cnt DESC
    `);

    // 4. All unique customsCN values
    const cs = await pool.query(`
      SELECT raw->>'customsCN' as customs_cn, COUNT(*) as cnt
      FROM shipping_plans
      GROUP BY raw->>'customsCN'
      ORDER BY cnt DESC
    `);

    // 5. Sample plans with shipment_no + customer + forwarder
    const sample = await pool.query(`
      SELECT shipment_no, customer,
        raw->>'forwarderCN' as forwarder_cn,
        raw->>'shippingLine' as shipping_line,
        raw->>'truckingCN' as trucking_cn,
        raw->>'customsCN' as customs_cn,
        raw->>'pol' as pol,
        raw->>'pod' as pod
      FROM shipping_plans
      ORDER BY created_at DESC LIMIT 19
    `);

    return res.status(200).json({
      success: true,
      totalPlans: sample.rowCount,
      forwarderCN_values: fwd.rows,
      shippingLine_values: sl.rows,
      truckingCN_values: tk.rows,
      customsCN_values: cs.rows,
      plans: sample.rows,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
