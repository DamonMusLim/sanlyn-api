// migrate-factory-portal.js — Phase 1 migration for factory-portal flow
// Creates: suppliers, factory_tokens, invoice_previews
// Idempotent: safe to run repeatedly.
// Trigger: curl -X POST https://api.sanlyn.cn/api/db/migrate-factory-portal
import { getPool, setCors } from "../db.js";

const SQL = `
-- ── suppliers ── Factory master record; phone = primary account ID
CREATE TABLE IF NOT EXISTS suppliers (
  id                    SERIAL PRIMARY KEY,
  phone_e164            VARCHAR(20) UNIQUE NOT NULL,
  tax_id                VARCHAR(32) UNIQUE,
  name_cn               VARCHAR(256) DEFAULT '',
  name_en               VARCHAR(256) DEFAULT '',
  business_license_url  TEXT,
  legal_rep             VARCHAR(64)  DEFAULT '',
  address               TEXT,
  business_scope        TEXT,
  contact_name          VARCHAR(64)  DEFAULT '',
  status                VARCHAR(16)  DEFAULT 'pending',
  phone_verified        BOOLEAN      DEFAULT false,
  phone_changed_count   INT          DEFAULT 0,
  raw                   JSONB        DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ  DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_suppliers_tax_id ON suppliers(tax_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_status ON suppliers(status);

-- ── factory_tokens ── One-time link for customer→factory forwarding
CREATE TABLE IF NOT EXISTS factory_tokens (
  token           VARCHAR(64) PRIMARY KEY,
  order_id        INTEGER,
  customer_code   VARCHAR(64),
  supplier_id     INTEGER REFERENCES suppliers(id),
  sku_lines       JSONB DEFAULT '[]'::jsonb,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  submission      JSONB DEFAULT '{}'::jsonb,
  created_by      VARCHAR(64),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ftokens_order  ON factory_tokens(order_id);
CREATE INDEX IF NOT EXISTS idx_ftokens_expiry ON factory_tokens(expires_at);

-- ── invoice_previews ── Invoice preview OCR + Damon review queue
CREATE TABLE IF NOT EXISTS invoice_previews (
  id              SERIAL PRIMARY KEY,
  supplier_id     INTEGER REFERENCES suppliers(id),
  order_id        INTEGER,
  token           VARCHAR(64) REFERENCES factory_tokens(token),
  oss_url         TEXT NOT NULL,
  ocr_json        JSONB DEFAULT '{}'::jsonb,
  matched_skus    TEXT[],
  proposed_products JSONB DEFAULT '[]'::jsonb,
  amount_total    NUMERIC(14,2),
  currency        VARCHAR(8) DEFAULT 'CNY',
  status          VARCHAR(16) DEFAULT 'pending',
  review_notes    TEXT,
  reviewed_by     VARCHAR(64),
  reviewed_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inv_prev_status ON invoice_previews(status);
CREATE INDEX IF NOT EXISTS idx_inv_prev_order  ON invoice_previews(order_id);
`;

export default async function handler(req, res) {
  setCors(req, res, "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!["POST", "GET"].includes(req.method)) return res.status(405).json({ error: "POST or GET only" });

  try {
    const pool = getPool();
    await pool.query(SQL);
    // Return current counts as a sanity check
    const counts = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM suppliers)        AS suppliers,
        (SELECT COUNT(*) FROM factory_tokens)   AS factory_tokens,
        (SELECT COUNT(*) FROM invoice_previews) AS invoice_previews
    `);
    return res.status(200).json({ success: true, message: "Factory-portal tables ready", counts: counts.rows[0] });
  } catch (err) {
    console.error("[migrate-factory-portal]", err);
    return res.status(500).json({ error: err.message });
  }
}
