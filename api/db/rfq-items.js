// api/db/rfq-items.js
// freight_rfq_items table CRUD — actual schema:
// id(uuid), rfq_id(uuid FK), forwarder_co, vessel, voyage, etd,
// usd_rate, transit_days, notes, is_lowest, selected, submitted_at

import { getPool, setCors } from "../db.js";

const ALLOWED_PATCH = ["forwarder_co","vessel","voyage","etd","usd_rate",
                       "transit_days","notes","is_lowest","selected"];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });

  const pool = getPool();

  // ── GET ──
  if (req.method === "GET") {
    const { rfq_id } = req.query;
    if (!rfq_id) return res.status(400).json({ error: "rfq_id required" });
    const { rows } = await pool.query(
      `SELECT * FROM freight_rfq_items WHERE rfq_id = $1 ORDER BY usd_rate ASC`,
      [rfq_id]
    );
    return res.status(200).json({ success: true, data: rows, count: rows.length });
  }

  // ── POST ──
  if (req.method === "POST") {
    const { rfq_id, forwarder_co, vessel, voyage, etd, usd_rate,
            transit_days, notes } = req.body || {};
    if (!rfq_id || !forwarder_co || !usd_rate)
      return res.status(400).json({ error: "rfq_id, forwarder_co, usd_rate required" });
    const { rows } = await pool.query(
      `INSERT INTO freight_rfq_items
         (rfq_id, forwarder_co, vessel, voyage, etd, usd_rate, transit_days, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [rfq_id, forwarder_co, vessel || null, voyage || null, etd || null,
       usd_rate, transit_days || null, notes || null]
    );
    // Recompute is_lowest across all items for this rfq
    await pool.query(
      `UPDATE freight_rfq_items SET is_lowest = (usd_rate = (
         SELECT MIN(usd_rate) FROM freight_rfq_items WHERE rfq_id = $1
       )) WHERE rfq_id = $1`,
      [rfq_id]
    );
    return res.status(201).json({ success: true, data: rows[0] });
  }

  // ── PATCH ──
  if (req.method === "PATCH") {
    const { id, rfq_id, ...patch } = req.body || {};
    if (!id) return res.status(400).json({ error: "id required" });
    const keys = Object.keys(patch).filter(k => ALLOWED_PATCH.includes(k));
    if (!keys.length) return res.status(400).json({ error: "no valid fields" });
    const sets = keys.map((k, i) => `${k} = $${i+2}`).join(", ");
    const vals = [id, ...keys.map(k => patch[k])];
    const { rows } = await pool.query(
      `UPDATE freight_rfq_items SET ${sets} WHERE id = $1 RETURNING *`, vals
    );
    if (!rows.length) return res.status(404).json({ error: "not found" });
    // Recompute is_lowest if usd_rate changed
    if (patch.usd_rate != null && rfq_id) {
      await pool.query(
        `UPDATE freight_rfq_items SET is_lowest = (usd_rate = (
           SELECT MIN(usd_rate) FROM freight_rfq_items WHERE rfq_id = $1
         )) WHERE rfq_id = $1`,
        [rfq_id]
      );
    }
    return res.status(200).json({ success: true, data: rows[0] });
  }

  return res.status(405).json({ error: "method not allowed" });
}
