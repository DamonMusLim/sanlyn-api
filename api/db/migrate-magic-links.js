// ═══════════════════════════════════════════════════════════════
// migrate-magic-links.js
// POST /api/db/migrate-magic-links
//   Admin-only one-shot migration:
//   1. CREATE TABLE magic_links
//   2. ALTER TABLE driver_assignments ADD recipient_role, access_log
//   3. CREATE INDEX magic_links_token_hash_idx
// ═══════════════════════════════════════════════════════════════
import { getPool, setCors } from "../db.js";
import { requireAuth }       from "../auth.js";

const STMTS = [
  // ── magic_links table ──────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS magic_links (
    id             SERIAL PRIMARY KEY,
    token_hash     TEXT        NOT NULL UNIQUE,   -- SHA-256 of raw token; never store raw
    recipient_role TEXT        NOT NULL,           -- driver/forwarder/customs/customer_downstream
    meta           JSONB       NOT NULL DEFAULT '{}',
      -- { sheet_id, sheet_table, contract_no, shipment_id,
      --   recipient_phone, recipient_email }
    access_log     JSONB       NOT NULL DEFAULT '[]',
      -- [{ accessed_at, ip, ua }, ...]
    used_at        TIMESTAMP WITH TIME ZONE,
    expires_at     TIMESTAMP WITH TIME ZONE NOT NULL,
    revoked_at     TIMESTAMP WITH TIME ZONE,
    created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    created_by     TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS magic_links_token_hash_idx
     ON magic_links (token_hash)`,

  `CREATE INDEX IF NOT EXISTS magic_links_role_created_idx
     ON magic_links (recipient_role, created_at DESC)`,

  // ── Extend driver_assignments ──────────────────────────────
  `ALTER TABLE driver_assignments
     ADD COLUMN IF NOT EXISTS recipient_role TEXT`,

  `ALTER TABLE driver_assignments
     ADD COLUMN IF NOT EXISTS access_log JSONB DEFAULT '[]'::jsonb`,

  `COMMENT ON COLUMN driver_assignments.recipient_role IS
     'driver/forwarder/customs/customer_downstream — mirrors magic_links.recipient_role for driver tasks'`,

  `COMMENT ON COLUMN driver_assignments.access_log IS
     '[{accessed_at, ip, ua}] — append-only access log for driver magic link QR scans'`,
];

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).end("POST only");
  if (!requireAuth(req, res))   return;

  const pool = getPool();
  const results = [];

  for (const sql of STMTS) {
    const label = sql.slice(0, 60).replace(/\s+/g, " ").trim() + "…";
    try {
      await pool.query(sql);
      results.push({ ok: true, sql: label });
    } catch (err) {
      results.push({ ok: false, sql: label, error: err.message });
    }
  }

  const failed = results.filter(r => !r.ok);
  return res.status(200).json({
    total:   results.length,
    ok:      results.filter(r => r.ok).length,
    failed:  failed.length,
    results,
    message: failed.length === 0
      ? "magic_links migration complete"
      : `${failed.length} statement(s) failed — see results`,
  });
}
