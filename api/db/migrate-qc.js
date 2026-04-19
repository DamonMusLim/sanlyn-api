import { getPool, setCors } from "../db.js";

// Phase 1: QC Checks schema
// - products.shelf_life_days (shelf life fixed per SKU, in days)
// - qc_checks table (one row per QC check event, allows backfill)

var STATEMENTS = [
  // 1. Add shelf_life_days to products (fixed per SKU)
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS shelf_life_days INT DEFAULT NULL`,

  // 2. Create qc_checks table
  `CREATE TABLE IF NOT EXISTS qc_checks (
    id                SERIAL PRIMARY KEY,
    order_contract_no VARCHAR(64) NOT NULL,
    product_id        INT REFERENCES products(id) ON DELETE SET NULL,
    product_sku       VARCHAR(64),

    -- Batch info (recorded during QC)
    batch_no          VARCHAR(64),
    production_date   DATE,
    best_before       DATE,
    qty               INT DEFAULT 0,

    -- QC core
    qc_result         VARCHAR(16) NOT NULL DEFAULT 'pending',
    qc_date           DATE,
    qc_by             VARCHAR(128),
    checklist         JSONB DEFAULT '{}'::jsonb,
    photos            JSONB DEFAULT '[]'::jsonb,
    fail_reason       TEXT DEFAULT '',

    -- Sanlyn review
    reviewed_by       VARCHAR(128),
    reviewed_at       TIMESTAMPTZ,
    review_status     VARCHAR(16) DEFAULT 'pending',

    -- Backfill tracking
    entry_mode        VARCHAR(16) DEFAULT 'realtime',
    entered_at        TIMESTAMPTZ DEFAULT NOW(),

    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_qc_order    ON qc_checks(order_contract_no)`,
  `CREATE INDEX IF NOT EXISTS idx_qc_product  ON qc_checks(product_id)`,
  `CREATE INDEX IF NOT EXISTS idx_qc_result   ON qc_checks(qc_result)`,
  `CREATE INDEX IF NOT EXISTS idx_qc_review   ON qc_checks(review_status)`,
];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    var pool = getPool();
    var log = [];
    for (var sql of STATEMENTS) {
      await pool.query(sql);
      log.push("OK: " + sql.slice(0, 80).replace(/\s+/g, " "));
    }
    return res.status(200).json({ ok: true, log });
  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
