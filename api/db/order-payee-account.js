// /api/db/order-payee-account
// BANK-ACCOUNT-PAYEE-MINIMAL-FIX-001
//
// GET /api/db/order-payee-account?orderId=<id>&currency=<USD|CNY>
//
// Returns the scoped payee bank account for a specific order.
// - customer: can only query their own orders (scoped by companyCodes)
// - admin/internal/finance: can query any order
// - Never returns full bank_accounts list
// - Never returns raw/internal fields
// - Fails closed: no companyCodes → 403

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// Legacy mapping: orders.seller_code → bank_accounts.company_code
// This adapter lives here (server-side only). Never sent to client.
const SELLER_CODE_TO_BANK_COMPANY = {
  petbaby:    "BABI",
  yangbaobao: "CN-00016",  // reserved — data quality TBD
};

const INTERNAL_ROLES = new Set(["admin", "finance", "trader", "logistics", "boss", "internal", "platform_admin"]);

function isInternal(user) {
  return user && INTERNAL_ROLES.has(String(user.role).toLowerCase());
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  const user     = req.user;
  const orderId  = req.query.orderId  || req.query.order_id;
  const currency = (req.query.currency || "USD").toUpperCase().trim();

  if (!orderId) {
    return res.status(400).json({ error: "orderId required" });
  }
  if (!["USD", "CNY"].includes(currency)) {
    return res.status(400).json({ error: "currency must be USD or CNY" });
  }

  const pool = getPool();

  try {
    // ── 1. Fetch the order, check scope ────────────────────────────────────────
    const oRes = await pool.query(
      `SELECT id, contract_no, seller_code, company_code
         FROM orders WHERE id = $1 LIMIT 1`,
      [orderId]
    );
    const order = oRes.rows[0];
    if (!order) {
      return res.status(404).json({ error: "order_not_found" });
    }

    // ── 2. Customer scope guard ────────────────────────────────────────────────
    if (!isInternal(user)) {
      const customerCodes = user.companyCodes || (user.company_code ? [user.company_code] : []);
      if (!customerCodes.length) {
        // Fail-closed: no company scope → 403
        return res.status(403).json({ error: "forbidden" });
      }
      if (!customerCodes.includes(order.company_code)) {
        return res.status(403).json({ error: "forbidden" });
      }
    }

    // ── 3. Resolve payee company code via legacy map ───────────────────────────
    const sellerCode       = order.seller_code || "petbaby";
    const bankCompanyCode  = SELLER_CODE_TO_BANK_COMPANY[sellerCode];
    if (!bankCompanyCode) {
      // seller_code not in legacy map — payee account not configured
      return res.status(200).json({
        success: true, data: null,
        _pending: "payee_account_not_configured",
      });
    }

    // ── 4. Fetch bank account (scoped: exact company + currency + active) ──────
    const bRes = await pool.query(
      `SELECT account_holder, bank_name, bank_name_en, account_no, swift, bank_address, currency
         FROM bank_accounts
        WHERE company_code = $1
          AND currency     = $2
          AND active       = true
          AND is_default   = true
        LIMIT 1`,
      [bankCompanyCode, currency]
    );
    const acct = bRes.rows[0] || null;

    if (!acct) {
      return res.status(200).json({
        success: true, data: null,
        _pending: `no_${currency}_account_configured`,
      });
    }

    // ── 5. Return scoped fields only — no id / raw / source / audit fields ─────
    return res.status(200).json({
      success: true,
      data: {
        account_holder: acct.account_holder || null,
        bank_name:      acct.bank_name      || null,
        bank_name_en:   acct.bank_name_en   || null,
        account_no:     acct.account_no     || null,
        swift:          acct.swift          || null,
        bank_address:   acct.bank_address   || null,
        currency:       acct.currency.trim(),
      },
    });

  } catch (err) {
    console.error("[order-payee-account] error:", err.message);
    return res.status(500).json({ error: "internal" });
  }
}
