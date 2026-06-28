import { getPool, setCors } from "../db.js";

var STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS ddp_quotes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ref_no TEXT UNIQUE NOT NULL,
    customer_name TEXT,
    customer_id UUID,
    country TEXT,
    flag TEXT,
    sub_region TEXT,
    mode TEXT,
    tier TEXT,
    cargo JSONB DEFAULT '{}',
    pickup_address TEXT,
    pickup_region TEXT,
    delivery_address TEXT,
    domestic_fee_min INT,
    domestic_fee_max INT,
    intl_ref_price TEXT,
    markup_pct NUMERIC(5,2) DEFAULT 15,
    display_price TEXT,
    status TEXT DEFAULT 'draft',
    source TEXT DEFAULT 'manual',
    raw_ocr JSONB,
    photos JSONB DEFAULT '[]',
    notes TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS ddp_rates (
    id SERIAL PRIMARY KEY,
    country TEXT NOT NULL,
    flag TEXT,
    sub_region TEXT,
    mode TEXT NOT NULL,
    tier TEXT NOT NULL,
    base_price NUMERIC(10,2),
    markup_pct NUMERIC(5,2) DEFAULT 15,
    unit TEXT,
    transit_days TEXT,
    notes TEXT,
    active BOOLEAN DEFAULT TRUE,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ddp_quotes_status ON ddp_quotes(status)`,
  `CREATE INDEX IF NOT EXISTS idx_ddp_quotes_country ON ddp_quotes(country)`,
  `CREATE INDEX IF NOT EXISTS idx_ddp_quotes_customer ON ddp_quotes(customer_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ddp_rates_country_mode ON ddp_rates(country, mode)`,
];

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const pool = getPool();
  const results = [];
  for (const sql of STATEMENTS) {
    try {
      await pool.query(sql);
      results.push({ ok: true, sql: sql.slice(0, 60) });
    } catch (e) {
      results.push({ ok: false, sql: sql.slice(0, 60), error: e.message });
    }
  }
  return res.status(200).json({ success: true, results });
}
