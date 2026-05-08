// /api/db/trucking-rates.js — Trucking rates CRUD
import { getPool, setCors } from "./db.js";

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS trucking_rates (
  id             SERIAL PRIMARY KEY,
  origin_city    VARCHAR(128),
  destination    VARCHAR(128),
  container_type VARCHAR(20) DEFAULT '20GP',
  amount         NUMERIC(12,2),
  currency       VARCHAR(8) DEFAULT 'CNY',
  provider       VARCHAR(200),
  valid_from     DATE,
  valid_until    DATE,
  notes          TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
`;

let inited = false;
async function ensureTable(pool) {
  if (inited) return;
  await pool.query(INIT_SQL);
  inited = true;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();
  await ensureTable(pool);

  if (req.method === "GET") {
    try {
      const { origin_city, destination, container_type, limit = 1000 } = req.query;
      let query = "SELECT * FROM trucking_rates", params = [], conds = [];
      if (origin_city)    { params.push(`%${origin_city}%`);    conds.push(`origin_city ILIKE $${params.length}`); }
      if (destination)    { params.push(`%${destination}%`);    conds.push(`destination ILIKE $${params.length}`); }
      if (container_type) { params.push(container_type);         conds.push(`container_type = $${params.length}`); }
      if (conds.length) query += " WHERE " + conds.join(" AND ");
      params.push(parseInt(limit));
      query += ` ORDER BY origin_city, destination, container_type, created_at DESC LIMIT $${params.length}`;
      const result = await pool.query(query, params);
      return res.status(200).json({ success: true, data: result.rows, count: result.rowCount });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (req.method === "POST") {
    try {
      const { origin_city, destination, container_type, amount, currency, provider, valid_from, valid_until, notes } = req.body || {};
      const r = await pool.query(
        `INSERT INTO trucking_rates(origin_city,destination,container_type,amount,currency,provider,valid_from,valid_until,notes)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [origin_city||null, destination||null, container_type||"20GP", amount||null, currency||"CNY",
         provider||null, valid_from||null, valid_until||null, notes||null]
      );
      return res.status(201).json({ success: true, data: r.rows[0] });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (req.method === "PATCH") {
    try {
      const { id, ...patch } = req.body || {};
      if (!id) return res.status(400).json({ error: "id required" });
      const allowed = ["origin_city","destination","container_type","amount","currency","provider","valid_from","valid_until","notes"];
      const sets = [], vals = [];
      for (const k of allowed) {
        if (patch[k] !== undefined) { vals.push(patch[k]); sets.push(`${k} = $${vals.length}`); }
      }
      if (!sets.length) return res.status(400).json({ error: "no fields to update" });
      vals.push(id); sets.push("updated_at = NOW()");
      const r = await pool.query(
        `UPDATE trucking_rates SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`, vals
      );
      if (!r.rowCount) return res.status(404).json({ error: "record not found" });
      return res.status(200).json({ success: true, data: r.rows[0] });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (req.method === "DELETE") {
    try {
      const id = req.query.id || req.body?.id;
      if (!id) return res.status(400).json({ error: "id required" });
      const r = await pool.query("DELETE FROM trucking_rates WHERE id = $1", [id]);
      if (!r.rowCount) return res.status(404).json({ error: "record not found" });
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
