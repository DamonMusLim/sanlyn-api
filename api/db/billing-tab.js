import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { hashToken, sendError } from "../lib/viewmodel-adapter.js";
import { resolveBillingRole } from "./billing-tab-lens.js";
import { getCompanyBilling, getShipmentBilling } from "./billing-tab-queries.js";

const TOKEN_ROLES = new Set(["supplier_portal", "forwarder", "customer_booking", "customer", "factory_booking", "factory"]);

function suffix(req) {
  return String(req.path || "").replace(/^\/api\/db\/billing-tab\/?/, "").replace(/^\/+/, "");
}

function rawToken(req) {
  return String(req.query?.token || "").trim();
}

function defaultDirection(role) {
  if (role === "factory" || role === "forwarder") return "payable";
  if (role === "customer") return "receivable";
  return undefined;
}

async function resolveMagicToken(pool, raw) {
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
  const row = r.rows[0];
  const meta = row.meta || {};
  const explicitScope = meta.company_code || meta.supplier_company_code ||
    meta.payer_company_code || meta.factory_company_code || null;
  const scopeCode = explicitScope || await deriveTokenScope(pool, row.recipient_role, meta);
  return {
    ...meta,
    role: row.recipient_role,
    recipient_role: row.recipient_role,
    scopeCode,
  };
}

async function deriveTokenScope(pool, role, meta) {
  const planId = parseInt(meta?.shipment_id || "", 10);
  if (!planId) return null;

  const plan = await pool.query(
    `SELECT bl_no, hbl_no FROM shipping_plans WHERE id = $1 LIMIT 1`,
    [planId]
  );
  const bls = [plan.rows[0]?.bl_no, plan.rows[0]?.hbl_no].filter(Boolean);
  if (!bls.length) return null;

  const scopeColumn = role === "supplier_portal" || role === "forwarder"
    ? "supplier_company_code"
    : "payer_company_code";
  const scoped = await pool.query(
    `SELECT DISTINCT ${scopeColumn} AS code
       FROM active_freight_supplier_bills
      WHERE bl_no = ANY($1::text[])
        AND ${scopeColumn} IS NOT NULL`,
    [bls]
  );
  const codes = scoped.rows.map((r) => r.code).filter(Boolean);
  return codes.length === 1 ? codes[0] : null;
}

async function roleContext(req, res, pool) {
  const raw = rawToken(req);
  if (raw) {
    const token = await resolveMagicToken(pool, raw);
    if (!token) {
      sendError(res, 401, "invalid_token", "invalid or expired token");
      return null;
    }
    return resolveBillingRole(req, token);
  }
  if (!requireAuth(req, res)) return null;
  const ctx = resolveBillingRole(req);
  if (ctx.role === "anonymous") {
    sendError(res, 403, "forbidden", "billing role required");
    return null;
  }
  return ctx;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return sendError(res, 405, "method_not_allowed", "GET only");

  const pool = getPool();
  const ctx = await roleContext(req, res, pool);
  if (!ctx) return;

  try {
    const path = suffix(req) || String(req.query.action || "");
    if (path === "shipment") {
      const data = await getShipmentBilling(pool, { bl_no: req.query.bl_no, ...ctx });
      return res.status(200).json({ success: true, role: ctx.role, data });
    }
    if (path === "company") {
      const data = await getCompanyBilling(pool, {
        company_code: req.query.company_code,
        direction: req.query.direction || defaultDirection(ctx.role),
        limit: req.query.limit,
        ...ctx,
      });
      return res.status(200).json({ success: true, role: ctx.role, data });
    }
    return sendError(res, 404, "not_found");
  } catch (err) {
    const status = err.statusCode || 500;
    return sendError(res, status, err.code || "internal_error", err.message);
  }
}
