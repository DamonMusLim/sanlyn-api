import { getPool, setCors } from "./db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const pool = getPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS freight_quotes (
        id SERIAL PRIMARY KEY,
        jdy_id TEXT UNIQUE,
        carrier TEXT,
        forwarder TEXT,
        pol TEXT,
        pod TEXT,
        route_code TEXT,
        price_20gp NUMERIC,
        price_40hq NUMERIC,
        thc NUMERIC,
        valid_from DATE,
        valid_to DATE,
        next_sailing DATE,
        eta DATE,
        free_days TEXT,
        remarks TEXT,
        raw JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    const cols = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='freight_quotes' ORDER BY ordinal_position
    `);
    return res.status(200).json({ ok: true, columns: cols.rows.map(r=>r.column_name) });
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}
