// /api/freight-quotes — list active freight quotes for the customer marketplace.
// Rewritten 2026-05-18: old jdy_id/carrier/price_20gp columns no longer exist
// after the freight_quotes table migration. Map to new schema:
//   carrier_code, forwarder_company_id, price_20gp_usd, price_40hq_usd,
//   transit_days, free_days_origin, free_days_dest, sailing_schedule
import { getPool, setCors } from "./db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const pool  = getPool();
    const today = new Date().toISOString().slice(0, 10);

    const result = await pool.query(`
      SELECT DISTINCT ON (pol, pod, carrier_code)
        id, carrier_code, forwarder_company_id, pol, pod, route_code, route_type,
        price_20gp_usd, price_40hq_usd, transit_days,
        free_days_origin, free_days_dest, sailing_schedule,
        valid_from, valid_to, remarks
      FROM freight_quotes
      WHERE (valid_to IS NULL OR valid_to >= $1)
        AND COALESCE(is_active, true) = true
        AND deleted_at IS NULL
      ORDER BY pol, pod, carrier_code, valid_from DESC NULLS LAST
    `, [today]);

    return res.status(200).json({
      success: true,
      data: result.rows.map(r => ({
        id:          r.id,
        carrier:     r.carrier_code  || "",
        forwarder:   r.forwarder_company_id || null,
        pol:         r.pol           || "",
        pod:         r.pod           || "",
        routeCode:   r.route_code    || "",
        routeType:   r.route_type    || "",
        price20gp:   r.price_20gp_usd ? parseFloat(r.price_20gp_usd) : null,
        price40hq:   r.price_40hq_usd ? parseFloat(r.price_40hq_usd) : null,
        transitDays: r.transit_days  != null ? parseInt(r.transit_days, 10) : null,
        freeDaysOrigin: r.free_days_origin || null,
        freeDaysDest:   r.free_days_dest   || null,
        sailingSchedule: r.sailing_schedule || null,
        validFrom:   r.valid_from  ? r.valid_from.toISOString().slice(0,10) : null,
        validTo:     r.valid_to    ? r.valid_to.toISOString().slice(0,10)   : null,
        remarks:     r.remarks     || "",
      })),
      count: result.rows.length,
    });
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}
