// migrate-factory-portal.js — Phase 1 migration (v3, collapsed per SaaS principle)
// See sanlyn_saas_principles.md — master data is 2 tables (customers + products).
// Business data lives in customers.raw JSONB.
// Only ONE hidden reverse-index table (_idx_tokens) for O(1) token lookup.
//
// Idempotent. Trigger: curl -X POST https://api.sanlyn.cn/api/db/migrate-factory-portal
import { getPool, setCors } from "../db.js";

const SQL = `
-- ── Extend customers with factory-specific columns ──
ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_e164           VARCHAR(20);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS tax_id               VARCHAR(32);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_verified       BOOLEAN DEFAULT false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_changed_count  INT DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cust_phone_e164
  ON customers (phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cust_tax_id
  ON customers (tax_id) WHERE tax_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cust_portal_role ON customers(portal_role);

-- ── Drop any v1/v2 fat tables ──
DROP TABLE IF EXISTS suppliers        CASCADE;
DROP TABLE IF EXISTS factory_tokens   CASCADE;
DROP TABLE IF EXISTS invoice_previews CASCADE;

-- ── Hidden reverse-index for token → company lookup ──
-- Underscore prefix signals: not a business table, index only.
CREATE TABLE IF NOT EXISTS _idx_tokens (
  token         VARCHAR(64) PRIMARY KEY,
  company_code  VARCHAR(64) NOT NULL,
  purpose       VARCHAR(32) NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx__idx_tokens_expiry  ON _idx_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx__idx_tokens_company ON _idx_tokens(company_code);
`;

export default async function handler(req, res) {
  setCors(req, res, "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!["POST", "GET"].includes(req.method)) return res.status(405).json({ error: "POST or GET only" });

  try {
    const pool = getPool();
    await pool.query(SQL);
    const counts = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM customers)                              AS customers,
        (SELECT COUNT(*) FROM customers WHERE portal_role='factory')  AS factories,
        (SELECT COUNT(*) FROM customers WHERE portal_role='customer') AS buyers,
        (SELECT COUNT(*) FROM products)                               AS products,
        (SELECT COUNT(*) FROM _idx_tokens)                            AS idx_tokens
    `);
    return res.status(200).json({
      success: true,
      message: "Factory-portal v3 ready — 2 master tables + 1 hidden index",
      counts: counts.rows[0],
    });
  } catch (err) {
    console.error("[migrate-factory-portal]", err);
    return res.status(500).json({ error: err.message });
  }
}
