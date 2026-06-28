// /api/db/forwarder-performance.js — 货代绩效 CRUD
import { getPool, setCors } from "./db.js";

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS forwarder_performance (
  id              SERIAL PRIMARY KEY,
  forwarder_name  TEXT NOT NULL,
  period          TEXT,
  shipment_count  INT DEFAULT 0,
  on_time_count   INT DEFAULT 0,
  avg_delay_days  NUMERIC(6,2),
  avg_cost_usd    NUMERIC(12,2),
  complaints      INT DEFAULT 0,
  rating          NUMERIC(3,1),
  notes           TEXT,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS forwarder_alert_rules (
  id              SERIAL PRIMARY KEY,
  forwarder_name  TEXT,
  metric          TEXT,
  threshold       NUMERIC,
  comparison      TEXT DEFAULT '>',
  action          TEXT DEFAULT 'notify',
  active          BOOLEAN DEFAULT true
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
      const { forwarder_name, period, limit = 200 } = req.query;
      let q = "SELECT * FROM forwarder_performance", params = [], conds = [];
      if (forwarder_name) { params.push(`%${forwarder_name}%`); conds.push(`forwarder_name ILIKE $${params.length}`); }
      if (period)         { params.push(period); conds.push(`period = $${params.length}`); }
      if (conds.length) q += " WHERE " + conds.join(" AND ");
      params.push(parseInt(limit));
      q += ` ORDER BY period DESC, forwarder_name ASC LIMIT $${params.length}`;
      const r = await pool.query(q, params);
      return res.status(200).json({ success: true, data: r.rows, count: r.rowCount });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  if (req.method === "POST") {
    try {
      const { forwarder_name, period, shipment_count, on_time_count, avg_delay_days, avg_cost_usd, complaints, rating, notes } = req.body || {};
      if (!forwarder_name) return res.status(400).json({ success: false, error: "forwarder_name required" });
      const r = await pool.query(
        `INSERT INTO forwarder_performance(forwarder_name,period,shipment_count,on_time_count,avg_delay_days,avg_cost_usd,complaints,rating,notes)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [forwarder_name, period||null, shipment_count||0, on_time_count||0,
         avg_delay_days||null, avg_cost_usd||null, complaints||0, rating||null, notes||null]
      );
      return res.status(201).json({ success: true, data: r.rows[0] });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  if (req.method === "PATCH") {
    try {
      const { id, ...fields } = req.body || {};
      if (!id) return res.status(400).json({ success: false, error: "id required" });
      const allowed = ["forwarder_name","period","shipment_count","on_time_count","avg_delay_days","avg_cost_usd","complaints","rating","notes"];
      const setClauses = [], params = [];
      for (const [k, v] of Object.entries(fields)) {
        if (!allowed.includes(k)) continue;
        params.push(v); setClauses.push(`${k} = $${params.length}`);
      }
      if (!setClauses.length) return res.status(400).json({ success: false, error: "no valid fields" });
      params.push(new Date().toISOString());
      setClauses.push(`updated_at = $${params.length}`);
      params.push(id);
      const r = await pool.query(`UPDATE forwarder_performance SET ${setClauses.join(",")} WHERE id=$${params.length} RETURNING *`, params);
      return res.status(200).json({ success: true, data: r.rows[0] });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  if (req.method === "DELETE") {
    try {
      const id = req.query.id || req.body?.id;
      if (!id) return res.status(400).json({ success: false, error: "id required" });
      await pool.query("DELETE FROM forwarder_performance WHERE id=$1", [id]);
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  return res.status(405).json({ success: false, error: "Method not allowed" });
}
