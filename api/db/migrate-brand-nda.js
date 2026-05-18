/**
 * migrate-brand-nda.js
 *
 * Phase 7 — NDA brand cross-customer redact (FAIL-CLOSED-2026-05-19)
 *
 * Adds:
 *   company_brand_permissions.is_exclusive  BOOLEAN  — brand is NDA/exclusive to
 *     one company; auto-hidden from all other companies' product queries.
 *   company_brand_permissions.nda_note      TEXT     — optional internal memo
 *
 * Idempotent.  Call:
 *   curl -X POST https://api.sanlyn.cn/api/db/migrate-brand-nda \
 *        -H "Authorization: Bearer <ADMIN_JWT>"
 *
 * Semantics:
 *   When a brand row has is_exclusive=true for Company A, getBrandScope() will
 *   subtract that brand from ANY other company's visible brand set, even if
 *   they technically have a 'full' or 'rfq' permission row for the same brand.
 */

import { getPool, setCors } from "../db.js";
import { requireAuth }      from "../auth.js";

const STATEMENTS = [
  // ── 1. Add columns (idempotent) ─────────────────────────────────────────
  `ALTER TABLE company_brand_permissions
     ADD COLUMN IF NOT EXISTS is_exclusive BOOLEAN NOT NULL DEFAULT false,
     ADD COLUMN IF NOT EXISTS nda_note     TEXT`,

  // ── 2. Index: fast lookup of exclusive brands per tenant ─────────────────
  `CREATE INDEX IF NOT EXISTS idx_cbp_exclusive
     ON company_brand_permissions (tenant_code, brand)
     WHERE is_exclusive = true`,
];

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "admin only" });
  }

  const pool    = getPool();
  const results = [];

  for (const sql of STATEMENTS) {
    const label = sql.trim().slice(0, 80).replace(/\s+/g, " ");
    try {
      await pool.query(sql);
      results.push({ ok: true, sql: label });
    } catch (err) {
      results.push({ ok: false, sql: label, error: err.message });
      return res.status(500).json({
        success: false,
        error:   `Migration failed at: ${label}`,
        detail:  err.message,
        completed: results,
      });
    }
  }

  return res.status(200).json({
    success: true,
    message: "migrate-brand-nda complete — is_exclusive, nda_note, idx_cbp_exclusive installed",
    results,
  });
}
