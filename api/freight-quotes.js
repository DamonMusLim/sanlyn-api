// /api/freight-quotes — list active rate cards for the customer marketplace/booking.
//
// 2026-06-11 repoint (Damon「运价关联」): the freight_quotes table is EMPTY (0
// rows) — real rate cards live in freight_rates (44+, maintained by
// shipping-rate-intake). This endpoint now reads freight_rates and keeps the
// old output field names so CustomerLogistics schedules / OceanScreen keep
// working unchanged.
//
// 成本泄漏铁律: price20gp/price40hq = CUSTOMER sell prices (customer_gp20 /
// customer_hq40) for every audience. The hq40/gp20 procurement-cost columns
// are exposed ONLY to internal roles, under explicit costGp20/costHq40 names.
// Missing sell price → null (frontend renders 询价), never cost fallback.
//
// CUSTOMER_FACING_LEAK_PATCH_001 retained: customer audience never sees
// forwarder / supplier identity (anti-跳单).
// Expiry: sailing dates compared in Asia/Singapore (UTC+8) — a 6/11 sailing
// stops showing at SG midnight, not PG-server-timezone midnight.
import { getPool, setCors } from "./db.js";
import { audienceForRole } from "./lib/customer-safe-fields.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const pool = getPool();

    const result = await pool.query(`
      SELECT id, carrier, forwarder, supplier_id, pol, pod, route_code, via,
             terminal, transit_days, next_sailing, freetime,
             free_days_base, free_days_ext, remarks,
             customer_gp20, customer_hq40, gp20, hq40
      FROM freight_rates
      WHERE status = 'active'
        AND (next_sailing IS NULL
             OR next_sailing::date >= (now() AT TIME ZONE 'Asia/Singapore')::date)
      ORDER BY pol, pod, next_sailing NULLS LAST, id DESC
    `);

    const role     = req.user?.role;
    const audience = audienceForRole(role);
    const seeVendor = (audience === "internal" || audience === "super_admin");

    return res.status(200).json({
      success: true,
      data: result.rows.map(r => {
        const sellGp = r.customer_gp20 != null ? parseFloat(r.customer_gp20) : null;
        const sellHq = r.customer_hq40 != null ? parseFloat(r.customer_hq40) : null;
        const out = {
          id:          r.id,
          _id:         r.id,
          carrier:     r.carrier    || "",
          pol:         r.pol        || "",
          pod:         r.pod        || "",
          routeCode:   r.route_code || "",
          routeType:   r.via ? "transship" : "",
          via:         r.via        || null,
          terminal:    r.terminal   || null,
          // Sell prices only — null = 询价, never the procurement cost.
          price20gp:   sellGp,
          price40hq:   sellHq,
          customerGp20: sellGp,
          customerHq40: sellHq,
          transitDays: r.transit_days != null ? parseInt(r.transit_days, 10) : null,
          nextSailing: r.next_sailing ? String(r.next_sailing).slice(0, 10) : null,
          freeDaysBase: r.free_days_base != null ? r.free_days_base : (r.freetime != null ? r.freetime : null),
          freeDaysExt:  r.free_days_ext  != null ? r.free_days_ext  : null,
          validTo:     null, // freight_rates has no validity window; sailing date is the cutoff
          remarks:     r.remarks || "",
        };
        if (seeVendor) {
          out.forwarder  = r.forwarder   || null;
          out.supplierId = r.supplier_id || null;
          out.costGp20   = r.gp20 != null ? parseFloat(r.gp20) : null;
          out.costHq40   = r.hq40 != null ? parseFloat(r.hq40) : null;
        }
        return out;
      }),
      count: result.rows.length,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
