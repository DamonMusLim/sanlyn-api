// /api/db/shipping-health-check.js
// GET — Returns a data-health report for all shipping_plans rows.
// Reports counts + IDs for: missing_contract_no, missing_route, missing_dates,
// missing_weights, no_orders_linked, and ready_to_book (all key fields present).
//
// Added: 2026-05-09 (Claude C backfill sprint)

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const pool = getPool();

  try {
    // Total count
    const totalRes = await pool.query("SELECT COUNT(*)::int AS total FROM shipping_plans");
    const total = totalRes.rows[0].total;

    // 1. Missing contract_no
    const missingContractNo = await pool.query(`
      SELECT id, _id, customer, etd::text, order_contract_nos
      FROM shipping_plans
      WHERE contract_no IS NULL
      ORDER BY etd DESC NULLS LAST
    `);

    // 2. Missing route (pol or pod is null/empty)
    const missingRoute = await pool.query(`
      SELECT id, _id, contract_no, customer
      FROM shipping_plans
      WHERE (pol IS NULL OR trim(pol) = '')
         OR (pod IS NULL OR trim(pod) = '')
      ORDER BY id
    `);

    // 3. Missing dates (etd or eta is null)
    const missingDates = await pool.query(`
      SELECT id, _id, contract_no, customer,
             etd::text, eta::text
      FROM shipping_plans
      WHERE etd IS NULL OR eta IS NULL
      ORDER BY id
    `);

    // 4. Missing weights (gross_weight_kg or total_cbm or total_cartons is null)
    const missingWeights = await pool.query(`
      SELECT id, _id, contract_no, customer,
             total_cartons, total_cbm, gross_weight_kg
      FROM shipping_plans
      WHERE gross_weight_kg IS NULL
         OR total_cbm IS NULL
         OR total_cartons IS NULL
      ORDER BY id
    `);

    // 5. No orders linked (contract_no exists but no matching order row)
    const noOrdersLinked = await pool.query(`
      SELECT sp.id, sp._id, sp.contract_no, sp.customer
      FROM shipping_plans sp
      WHERE sp.contract_no IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM orders o WHERE o.contract_no = sp.contract_no
        )
      ORDER BY sp.id
    `);

    // 6. Ready to book: has contract_no + pol + pod + etd + eta + (bl_no OR container_no)
    //    and at least one weight field present
    const readyToBook = await pool.query(`
      SELECT id, _id, contract_no, customer, etd::text, eta::text, pol, pod
      FROM shipping_plans
      WHERE contract_no IS NOT NULL
        AND pol IS NOT NULL AND trim(pol) != ''
        AND pod IS NOT NULL AND trim(pod) != ''
        AND etd IS NOT NULL
        AND eta IS NOT NULL
        AND gross_weight_kg IS NOT NULL
        AND total_cbm IS NOT NULL
        AND total_cartons IS NOT NULL
      ORDER BY etd DESC
    `);

    const toIds = (rows) => rows.map((r) => r.id);

    return res.status(200).json({
      success: true,
      generated_at: new Date().toISOString(),
      total,
      issues: {
        missing_contract_no: {
          count: missingContractNo.rows.length,
          ids: toIds(missingContractNo.rows),
          rows: missingContractNo.rows,
        },
        missing_route: {
          count: missingRoute.rows.length,
          ids: toIds(missingRoute.rows),
          rows: missingRoute.rows,
        },
        missing_dates: {
          count: missingDates.rows.length,
          ids: toIds(missingDates.rows),
          rows: missingDates.rows,
        },
        missing_weights: {
          count: missingWeights.rows.length,
          ids: toIds(missingWeights.rows),
          rows: missingWeights.rows,
        },
        no_orders_linked: {
          count: noOrdersLinked.rows.length,
          ids: toIds(noOrdersLinked.rows),
          rows: noOrdersLinked.rows,
        },
      },
      ready_to_book: {
        count: readyToBook.rows.length,
        ids: toIds(readyToBook.rows),
        rows: readyToBook.rows,
      },
    });
  } catch (err) {
    console.error("[shipping-health-check] error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
