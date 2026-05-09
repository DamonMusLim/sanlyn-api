// api/db/rfq-requests.js
// freight_rfqs table CRUD — actual schema: id(uuid), order_id, pol, pod,
// ctnr_type, status, awarded_item_id, markup_usd, client_rate_usd, created_by, created_at

import { getPool, setCors } from "../db.js";

const ALLOWED_PATCH = ["pol","pod","ctnr_type","status","awarded_item_id",
                       "markup_usd","client_rate_usd","order_id","etd","route"];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });

  const pool = getPool();

  // ── GET ──
  if (req.method === "GET") {
    const { status, order_id, limit = 200 } = req.query;
    const where = [];
    const vals = [];
    if (status) { where.push(`r.status = $${vals.length+1}`); vals.push(status); }
    if (order_id) { where.push(`r.order_id = $${vals.length+1}`); vals.push(order_id); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const sql = `
      SELECT r.id, r.order_id, r.pol, r.pod, r.ctnr_type, r.status,
             r.awarded_item_id, r.markup_usd, r.client_rate_usd,
             r.created_by, r.created_at, r.updated_at, r.etd, r.route,
             o.order_no, o.customer
      FROM freight_rfqs r
      LEFT JOIN orders o ON o.id = r.order_id
      ${clause}
      ORDER BY r.created_at DESC
      LIMIT $${vals.length+1}`;
    vals.push(limit);
    const { rows } = await pool.query(sql, vals);
    return res.status(200).json({ success: true, data: rows, count: rows.length });
  }

  // ── POST ──
  if (req.method === "POST") {
    const { pol, pod, ctnr_type, status = "open", order_id, etd, route,
            markup_usd = 0, client_rate_usd, created_by } = req.body || {};
    if (!pol || !pod) return res.status(400).json({ error: "pol and pod required" });
    const { rows } = await pool.query(
      `INSERT INTO freight_rfqs (pol, pod, ctnr_type, status, order_id, etd, route,
         markup_usd, client_rate_usd, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [pol, pod, ctnr_type || "20GP", status, order_id || null, etd || null,
       route || null, markup_usd, client_rate_usd || null,
       created_by || req.user?.username || null]
    );
    return res.status(201).json({ success: true, data: rows[0] });
  }

  // ── PATCH ──
  if (req.method === "PATCH") {
    const { id, ...patch } = req.body || {};
    if (!id) return res.status(400).json({ error: "id required" });
    const keys = Object.keys(patch).filter(k => ALLOWED_PATCH.includes(k));
    if (!keys.length) return res.status(400).json({ error: "no valid fields" });
    const sets = keys.map((k, i) => `${k} = $${i+2}`).join(", ");
    const vals = [id, ...keys.map(k => patch[k])];
    const { rows } = await pool.query(
      `UPDATE freight_rfqs SET ${sets}, updated_at = NOW()
       WHERE id = $1 RETURNING *`, vals
    );
    if (!rows.length) return res.status(404).json({ error: "not found" });
    return res.status(200).json({ success: true, data: rows[0] });
  }

  return res.status(405).json({ error: "method not allowed" });
}
