// Customer statement portal readonly data endpoint.
// Mount example: router.get("/api/db/statement-portal-data", statementPortalData).
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { callerCompanyScope, hashToken, sendError } from "../lib/viewmodel-adapter.js";
import { applyStatementFilters, buildSummary, clean, fetchStatementRows, filters } from "./statement-portal-helpers.js";

const TOKEN_ROLES = new Set(["customer", "customer_booking", "customer_downstream"]);

function tokenFrom(req) {
  return clean(req.query?.token || req.body?.token);
}

async function deriveScopeFromShipment(pool, meta) {
  const shipmentId = parseInt(meta?.shipment_id || "", 10);
  if (!shipmentId) return null;
  const plan = await pool.query(
    `SELECT bl_no, hbl_no FROM shipping_plans WHERE id = $1 LIMIT 1`,
    [shipmentId]
  );
  const bls = [plan.rows[0]?.bl_no, plan.rows[0]?.hbl_no].filter(Boolean);
  if (!bls.length) return null;
  const scoped = await pool.query(
    `SELECT DISTINCT payer_company_code AS code
       FROM active_freight_supplier_bills
      WHERE bl_no = ANY($1::text[])
        AND NULLIF(payer_company_code, '') IS NOT NULL`,
    [bls]
  );
  const codes = scoped.rows.map((r) => clean(r.code)).filter(Boolean);
  return codes.length === 1 ? codes[0] : null;
}

async function resolveMagicScope(pool, raw) {
  if (!raw) return null;
  const r = await pool.query(
    `SELECT recipient_role, meta
       FROM magic_links
      WHERE token_hash = $1
        AND expires_at > NOW()
        AND revoked_at IS NULL
        AND recipient_role = ANY($2::text[])
      LIMIT 1`,
    [hashToken(raw), Array.from(TOKEN_ROLES)]
  );
  if (!r.rows.length) return null;
  const meta = r.rows[0].meta || {};
  return clean(meta.company_code || meta.payer_company_code) || deriveScopeFromShipment(pool, meta);
}

async function resolveCustomerScope(req, res, pool) {
  const raw = tokenFrom(req);
  if (raw) {
    const scopeCode = await resolveMagicScope(pool, raw);
    if (!scopeCode) return sendError(res, 401, "invalid_token", "invalid or expired customer token"), null;
    return scopeCode;
  }
  if (!requireAuth(req, res)) return null;
  const role = clean(req.user?.role).toLowerCase();
  if (role !== "customer" && role !== "customer_booking") {
    return sendError(res, 403, "forbidden", "customer scope required"), null;
  }
  const scope = callerCompanyScope(req);
  const code = clean(scope.primary || scope.all?.[0]);
  if (!code) return sendError(res, 401, "missing_scope", "customer scope missing"), null;
  return code;
}

export async function statementPortalData(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return sendError(res, 405, "method_not_allowed", "GET only");
  const pool = getPool();
  try {
    const scopeCode = await resolveCustomerScope(req, res, pool);
    if (!scopeCode) return;
    const rows = applyStatementFilters(await fetchStatementRows(pool, scopeCode), filters(req));
    return res.status(200).json({ success: true, rows, summary: buildSummary(rows) });
  } catch (err) {
    console.error("[statement-portal-data]", err);
    return sendError(res, 500, "internal_error", err.message);
  }
}

export default statementPortalData;

// Reused: magic_links token hash pattern, JWT customer company scope,
// recon-board helpers, orders/finance_payments AR matching, freight sale_amount.
// Final line count after this edit: 89.
