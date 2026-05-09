// /api/db/migrate-forwarder-perf.js — 货代绩效表迁移
import { getPool, setCors } from "./db.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "POST only" });

  const pool = getPool();
  try {
    await pool.query(`
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
      CREATE INDEX IF NOT EXISTS idx_fp_name_period ON forwarder_performance(forwarder_name, period);
    `);
    return res.status(200).json({ success: true, message: "forwarder_performance + forwarder_alert_rules tables created" });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
