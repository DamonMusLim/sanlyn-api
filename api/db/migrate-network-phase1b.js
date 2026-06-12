// migrate-network-phase1b.js
// POST /api/db/migrate-network-phase1b
//
// Phase 1B: Network / Growth Center schema bootstrap
//   1. factory_invites  — add opened_at / referred_by / sales_owner
//   2. customers        — add profile_completed_at / first_order_at / sales_owner / referred_by / partner_status
//   3. partner_relationships — create table + add commission_model JSONB
//   4. network_invites_view — unified read adapter over factory_invites

import { getPool, setCors } from "../db.js";

var STATEMENTS = [
  // ── 1. factory_invites new columns ──────────────────────────
  `ALTER TABLE factory_invites
     ADD COLUMN IF NOT EXISTS opened_at    TIMESTAMPTZ DEFAULT NULL`,
  `ALTER TABLE factory_invites
     ADD COLUMN IF NOT EXISTS referred_by  VARCHAR(64)  DEFAULT NULL`,
  `ALTER TABLE factory_invites
     ADD COLUMN IF NOT EXISTS sales_owner  VARCHAR(64)  DEFAULT NULL`,

  // ── 2. customers new columns ─────────────────────────────────
  `ALTER TABLE customers
     ADD COLUMN IF NOT EXISTS profile_completed_at TIMESTAMPTZ DEFAULT NULL`,
  `ALTER TABLE customers
     ADD COLUMN IF NOT EXISTS first_order_at       TIMESTAMPTZ DEFAULT NULL`,
  `ALTER TABLE customers
     ADD COLUMN IF NOT EXISTS sales_owner          VARCHAR(64)  DEFAULT NULL`,
  `ALTER TABLE customers
     ADD COLUMN IF NOT EXISTS referred_by          VARCHAR(64)  DEFAULT NULL`,
  `ALTER TABLE customers
     ADD COLUMN IF NOT EXISTS partner_status       VARCHAR(20)  DEFAULT 'pending'`,

  // ── 3. partner_relationships table ──────────────────────────
  `CREATE TABLE IF NOT EXISTS partner_relationships (
    id               BIGSERIAL PRIMARY KEY,
    company_code_a   VARCHAR(64) NOT NULL,
    company_code_b   VARCHAR(64) NOT NULL,
    relationship_type VARCHAR(32) NOT NULL DEFAULT 'partner',
      -- 'customer' | 'supplier' | 'broker' | 'colleague' | 'partner'
    status           VARCHAR(16) DEFAULT 'active',
    referred_by      VARCHAR(64) DEFAULT NULL,
    sales_owner      VARCHAR(64) DEFAULT NULL,
    commission_model JSONB       DEFAULT NULL,
    notes            TEXT        DEFAULT '',
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_rel_pair
     ON partner_relationships(company_code_a, company_code_b, relationship_type)`,
  `CREATE INDEX IF NOT EXISTS idx_partner_rel_a ON partner_relationships(company_code_a)`,
  `CREATE INDEX IF NOT EXISTS idx_partner_rel_b ON partner_relationships(company_code_b)`,

  // ── 4. network_invites_view ──────────────────────────────────
  `CREATE OR REPLACE VIEW network_invites_view AS
   SELECT
     id,
     token,
     type,
     factory_name   AS company_name,
     contact_name,
     contact_email,
     contact_phone,
     channel,
     channel_value,
     message,
     invited_by,
     referred_by,
     sales_owner,
     status,
     opened_at,
     created_at,
     expires_at,
     used_at         AS registered_at
   FROM factory_invites`,
];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  var pool = getPool();
  var log = [];
  try {
    for (var sql of STATEMENTS) {
      await pool.query(sql);
      log.push("OK: " + sql.slice(0, 80).replace(/\s+/g, " ").trim() + "…");
    }
    return res.status(200).json({
      ok: true,
      statements_run: STATEMENTS.length,
      log,
    });
  } catch (err) {
    console.error("[migrate-network-phase1b]", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
