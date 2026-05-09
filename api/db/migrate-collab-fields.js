// migrate-collab-fields.js — 协同表 + 三层定价 字段迁移
//
// POST /api/db/migrate-collab-fields  (admin auth)
//
// Adds all columns introduced in 2026-05-10 session:
//   shipping_plans: 5 collab state columns
//   orders:         5 three-tier pricing columns + display_code support
//   customers:      display_code
//   factories:      display_code (if table exists)
//   drivers:        display_code (if table exists)
//
// Idempotent — all ADD COLUMN IF NOT EXISTS.

import { getPool, setCors } from "../db.js";
import { requireAuth }      from "../auth.js";

const SQL = `
-- ── shipping_plans: collab workflow fields ─────────────────────
ALTER TABLE shipping_plans
  ADD COLUMN IF NOT EXISTS cargo_ready_date       DATE,
  ADD COLUMN IF NOT EXISTS factory_confirmed_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS customer_confirmed_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS booking_sent_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS collab_sheet_status    TEXT NOT NULL DEFAULT 'draft';

-- ── orders: three-tier pricing fields ──────────────────────────
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS factory_price_total    NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS middleman_code         TEXT,
  ADD COLUMN IF NOT EXISTS middleman_markup_total NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS middleman_markup_pct   NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS customer_price_total   NUMERIC(14,2);

-- ── display_code: privacy isolation coding ─────────────────────
ALTER TABLE customers  ADD COLUMN IF NOT EXISTS display_code TEXT;
`;

// Separate statements for tables that may not exist
const OPTIONAL_SQL = [
  `ALTER TABLE factories ADD COLUMN IF NOT EXISTS display_code TEXT`,
  `ALTER TABLE drivers   ADD COLUMN IF NOT EXISTS display_code TEXT`,
];

// Backfill display_code values
const BACKFILL_SQL = `
UPDATE customers
SET display_code = 'C-' || id || '-' || UPPER(LEFT(COALESCE(company_code, 'XX'), 2))
WHERE display_code IS NULL;
`;

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

    const pool = getPool();
    const results = [];

    try {
      await pool.query(SQL);
      results.push({ step: "main_columns", ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message, step: "main_columns" });
    }

    for (const sql of OPTIONAL_SQL) {
      try {
        await pool.query(sql);
        results.push({ step: sql.slice(0, 50), ok: true });
      } catch (e) {
        results.push({ step: sql.slice(0, 50), ok: false, error: e.message });
      }
    }

    try {
      const r = await pool.query(BACKFILL_SQL);
      results.push({ step: "backfill_display_code", ok: true, rowCount: r.rowCount });
    } catch (e) {
      results.push({ step: "backfill_display_code", ok: false, error: e.message });
    }

    res.json({ success: true, results, message: "migrate-collab-fields complete — all columns idempotent" });
}
