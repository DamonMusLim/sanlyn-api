import { getPool, setCors } from "../db.js";
export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const pool = getPool();
    const { pol, pod, carrier, limit = 1000 } = req.query;
    let query = `SELECT id, pol, pod, carrier,
      route_code AS "routeCode", gp20, hq40,
      customer_gp20 AS "customerGp20", customer_hq40 AS "customerHq40",
      this_week AS "thisWeek", next_week AS "nextWeek",
      next_sailing AS "nextSailing",
      valid_from AS "validFrom", valid_to AS "validTo",
      transit_days AS "transitDays", thc, remarks, raw,
      created_at AS "createdAt", updated_at AS "updatedAt"
      FROM freight_rates`, params = [], conds = [];
    if (pol) { params.push(`%${pol}%`); conds.push(`pol ILIKE $${params.length}`); }
    if (pod) { params.push(`%${pod}%`); conds.push(`pod ILIKE $${params.length}`); }
    if (carrier) { params.push(`%${carrier}%`); conds.push(`carrier ILIKE $${params.length}`); }
    if (conds.length) query += " WHERE " + conds.join(" AND ");
    params.push(parseInt(limit));
    query += ` ORDER BY created_at DESC LIMIT $${params.length}`;
    const result = await pool.query(query, params);
    return res.status(200).json(result.rows);
  } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
}
