import { getPool, setCors } from "./db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const pool  = getPool();
    const today = new Date().toISOString().slice(0, 10);

    const result = await pool.query(`
      SELECT DISTINCT ON (pol, pod, carrier)
        jdy_id as id, carrier, forwarder, pol, pod, route_code,
        price_20gp, price_40hq, thc, valid_from, valid_to,
        next_sailing, eta, free_days, remarks
      FROM freight_quotes
      WHERE valid_to IS NULL OR valid_to >= $1
      ORDER BY pol, pod, carrier, valid_from DESC NULLS LAST
    `, [today]);

    return res.status(200).json({
      success: true,
      data:    result.rows.map(r => ({
        id:          r.id,
        carrier:     r.carrier     || "",
        forwarder:   r.forwarder   || "",
        pol:         r.pol         || "",
        pod:         r.pod         || "",
        routeCode:   r.route_code  || "",
        price20gp:   r.price_20gp  ? parseFloat(r.price_20gp)  : null,
        price40hq:   r.price_40hq  ? parseFloat(r.price_40hq)  : null,
        thc:         r.thc         ? parseFloat(r.thc)         : null,
        validFrom:   r.valid_from  ? r.valid_from.toISOString().slice(0,10)   : null,
        validTo:     r.valid_to    ? r.valid_to.toISOString().slice(0,10)     : null,
        nextSailing: r.next_sailing? r.next_sailing.toISOString().slice(0,10) : null,
        eta:         r.eta         ? r.eta.toISOString().slice(0,10)          : null,
        freeDays:    r.free_days   || "",
        remarks:     r.remarks     || "",
      })),
      count: result.rows.length,
    });
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}
