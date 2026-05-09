// api/db/migrate-rfq.js
// Idempotent schema creation for freight_rfqs + freight_rfq_items.
// POST /api/db/migrate-rfq  (admin only)

import { getPool, setCors } from "../db.js";

const STMTS = [
  `CREATE TABLE IF NOT EXISTS freight_rfqs (
    id               SERIAL PRIMARY KEY,
    rfq_no           TEXT,
    order_no         TEXT,
    customer         TEXT,
    pol              TEXT,
    pod              TEXT,
    container_type   TEXT,
    cargo_weight     NUMERIC,
    cargo_cbm        NUMERIC,
    target_etd       DATE,
    status           TEXT DEFAULT 'draft',
    markup_pct       NUMERIC DEFAULT 15,
    selected_item_id INT,
    sanlyn_quote_usd NUMERIC,
    notes            TEXT,
    created_at       TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS freight_rfq_items (
    id               SERIAL PRIMARY KEY,
    rfq_id           INT REFERENCES freight_rfqs(id),
    forwarder_name   TEXT,
    freight_usd      NUMERIC,
    port_surcharge   NUMERIC,
    thc              NUMERIC,
    doc_fee          NUMERIC,
    total_usd        NUMERIC,
    transit_days     INT,
    valid_until      DATE,
    notes            TEXT,
    created_at       TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS ix_rfq_items_rfq_id ON freight_rfq_items(rfq_id)`,
];

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!req.user || req.user.role !== "admin")
    return res.status(403).json({ error: "admin only" });
  if (req.method !== "POST")
    return res.status(405).json({ error: "POST required" });

  const pool = getPool();
  const results = [];
  try {
    for (const sql of STMTS) {
      await pool.query(sql);
      results.push({ ok: true });
    }
    return res.status(200).json({ ok: true, steps: results.length });
  } catch (e) {
    return res.status(500).json({ error: e.message, done: results.length });
  }
}
