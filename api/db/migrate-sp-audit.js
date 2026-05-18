/**
 * migrate-sp-audit.js
 *
 * BL/ETA Audit Trail — Phase 5 (FAIL-CLOSED-2026-05-19)
 *
 * Adds:
 *   shipping_plans.field_audit_log  JSONB  — array of field-change events
 *   shipping_plans.bill_revisions   JSONB  — array of freight_sale_usd change events
 *   trg_sp_audit trigger            — auto-records changes to key fields on UPDATE
 *
 * Idempotent. Call:
 *   curl -X POST https://api.sanlyn.cn/api/db/migrate-sp-audit \
 *        -H "Authorization: Bearer <ADMIN_JWT>"
 *
 * Monitored fields: bl_no, etd, eta, freight_sale_usd, flow_status, vessel, voyage
 */

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const STATEMENTS = [
  // ── 1. Add audit columns (idempotent) ───────────────────────────────────
  `ALTER TABLE shipping_plans
    ADD COLUMN IF NOT EXISTS field_audit_log JSONB DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS bill_revisions  JSONB DEFAULT '[]'::jsonb`,

  // ── 2. Audit trigger function ────────────────────────────────────────────
  `CREATE OR REPLACE FUNCTION sp_audit_field_changes()
  RETURNS trigger AS $$
  DECLARE
    changes JSONB := '[]'::jsonb;
    entry   JSONB;
  BEGIN
    -- bl_no change
    IF OLD.bl_no IS DISTINCT FROM NEW.bl_no THEN
      entry := jsonb_build_object(
        'field', 'bl_no',
        'old',   OLD.bl_no,
        'new',   NEW.bl_no,
        'at',    to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'by',    COALESCE(current_setting('app.current_user', true), 'system')
      );
      changes := changes || entry;
    END IF;

    -- etd change
    IF OLD.etd IS DISTINCT FROM NEW.etd THEN
      entry := jsonb_build_object(
        'field', 'etd',
        'old',   OLD.etd::text,
        'new',   NEW.etd::text,
        'at',    to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'by',    COALESCE(current_setting('app.current_user', true), 'system')
      );
      changes := changes || entry;
    END IF;

    -- eta change
    IF OLD.eta IS DISTINCT FROM NEW.eta THEN
      entry := jsonb_build_object(
        'field', 'eta',
        'old',   OLD.eta::text,
        'new',   NEW.eta::text,
        'at',    to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'by',    COALESCE(current_setting('app.current_user', true), 'system')
      );
      changes := changes || entry;
    END IF;

    -- freight_sale_usd change (also goes into bill_revisions)
    IF OLD.freight_sale_usd IS DISTINCT FROM NEW.freight_sale_usd THEN
      entry := jsonb_build_object(
        'field', 'freight_sale_usd',
        'old',   OLD.freight_sale_usd::text,
        'new',   NEW.freight_sale_usd::text,
        'at',    to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'by',    COALESCE(current_setting('app.current_user', true), 'system')
      );
      changes := changes || entry;
      NEW.bill_revisions := COALESCE(NEW.bill_revisions, '[]'::jsonb) || entry;
    END IF;

    -- flow_status change
    IF OLD.flow_status IS DISTINCT FROM NEW.flow_status THEN
      entry := jsonb_build_object(
        'field', 'flow_status',
        'old',   OLD.flow_status,
        'new',   NEW.flow_status,
        'at',    to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'by',    COALESCE(current_setting('app.current_user', true), 'system')
      );
      changes := changes || entry;
    END IF;

    -- vessel change
    IF OLD.vessel IS DISTINCT FROM NEW.vessel THEN
      entry := jsonb_build_object(
        'field', 'vessel',
        'old',   OLD.vessel,
        'new',   NEW.vessel,
        'at',    to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'by',    COALESCE(current_setting('app.current_user', true), 'system')
      );
      changes := changes || entry;
    END IF;

    -- voyage change
    IF OLD.voyage IS DISTINCT FROM NEW.voyage THEN
      entry := jsonb_build_object(
        'field', 'voyage',
        'old',   OLD.voyage,
        'new',   NEW.voyage,
        'at',    to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'by',    COALESCE(current_setting('app.current_user', true), 'system')
      );
      changes := changes || entry;
    END IF;

    -- Append all changes to field_audit_log
    IF jsonb_array_length(changes) > 0 THEN
      NEW.field_audit_log := COALESCE(NEW.field_audit_log, '[]'::jsonb) || changes;
    END IF;

    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql`,

  // ── 3. Attach trigger (drop first for idempotency) ───────────────────────
  `DROP TRIGGER IF EXISTS trg_sp_audit ON shipping_plans`,

  `CREATE TRIGGER trg_sp_audit
    BEFORE UPDATE ON shipping_plans
    FOR EACH ROW
    EXECUTE FUNCTION sp_audit_field_changes()`,

  // ── 4. Index for fast retrieval by shipment ──────────────────────────────
  `CREATE INDEX IF NOT EXISTS idx_sp_field_audit ON shipping_plans
    USING GIN (field_audit_log)
    WHERE field_audit_log IS NOT NULL AND field_audit_log != '[]'::jsonb`,
];

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "admin only" });
  }

  const pool = getPool();
  const results = [];

  for (const sql of STATEMENTS) {
    const label = sql.trim().slice(0, 60).replace(/\s+/g, " ");
    try {
      await pool.query(sql);
      results.push({ ok: true, sql: label });
    } catch (err) {
      results.push({ ok: false, sql: label, error: err.message });
      return res.status(500).json({
        success: false,
        error: `Migration failed at: ${label}`,
        detail: err.message,
        completed: results,
      });
    }
  }

  return res.status(200).json({
    success: true,
    message: "migrate-sp-audit complete — field_audit_log, bill_revisions, trg_sp_audit installed",
    results,
  });
}
