// /api/db/migrate-local-charges.js
// POST /api/db/migrate-local-charges
// Adds locked-rate columns to local_charges table.
// Also adds PATCH support columns for per-row charge_code/name/amount etc.
import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const pool = getPool();
  try {
    await pool.query(`
      ALTER TABLE local_charges
        ADD COLUMN IF NOT EXISTS charge_code       VARCHAR(60),
        ADD COLUMN IF NOT EXISTS charge_name       VARCHAR(200),
        ADD COLUMN IF NOT EXISTS amount            NUMERIC(12,2),
        ADD COLUMN IF NOT EXISTS charge_type       VARCHAR(80),
        ADD COLUMN IF NOT EXISTS applicable_trade  VARCHAR(20) DEFAULT 'both',
        ADD COLUMN IF NOT EXISTS valid_from        DATE,
        ADD COLUMN IF NOT EXISTS valid_until       DATE,
        ADD COLUMN IF NOT EXISTS notes             TEXT,
        ADD COLUMN IF NOT EXISTS currency          VARCHAR(10) DEFAULT 'USD',
        ADD COLUMN IF NOT EXISTS locked            BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS locked_at         TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS effective_from    DATE,
        ADD COLUMN IF NOT EXISTS updated_by        VARCHAR(120),
        ADD COLUMN IF NOT EXISTS prev_cost_total   NUMERIC(12,2)
    `);

    return res.status(200).json({ success: true, message: "local_charges columns added" });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
