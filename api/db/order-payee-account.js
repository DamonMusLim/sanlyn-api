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
//
// PAYEE ROUTING RULES (updated 2026-05-13):
// ┌─────────────────────────────────────┬────────────────────────────────┐
// │ Condition                           │ Payee company_code             │
// ├─────────────────────────────────────┼────────────────────────────────┤
// │ trade_terms ∈ {DDP,DAP,DDU,CNF,CNI} │ BABI (厦门巴匕出口有限公司)    │
// │ trade_terms ∈ {FOB,CIF,CFR,EXW,...} │ CN-00016 (上海洋贝国际物流)    │
// │ trade_terms missing, seller_code set│ SELLER_CODE_TO_BANK_COMPANY    │
// │ nothing matched                     │ null → frontend shows "Pending"│
// └─────────────────────────────────────┴────────────────────────────────┘
//
// To add a new supplier/forwarder:
//   1. INSERT INTO bank_accounts (company_code, currency, account_holder, …, active, is_default)
//   2. Add the routing rule to INCOTERM_TO_COMPANY or SELLER_CODE_TO_BANK_COMPANY below.

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// ── Payee routing: incoterm → bank_accounts.company_code ─────────────────────
// Incoterms where Sanlyn acts as the all-in seller (BABI collects)
const BABI_TERMS = new Set(["DDP", "DAP", "DDU", "CNF", "CNI", "CIF", "CFR"]);
// Incoterms where logistics arm (上海洋贝) collects freight separately
const YANGBAO_TERMS = new Set(["FOB", "EXW", "FCA", "CPT", "CIP"]);

const INCOTERM_TO_COMPANY = {
  // All-in delivery: BABI (厦门巴匕出口有限公司)
  DDP: "BABI", DAP: "BABI", DDU: "BABI",
  CNF: "BABI", CNI: "BABI", CIF: "BABI", CFR: "BABI",
  // Origin-only: 上海洋贝国际物流有限公司
  FOB: "CN-00016", EXW: "CN-00016", FCA: "CN-00016",
  CPT: "CN-00016", CIP: "CN-00016",
};

// Fallback: orders.seller_code → bank_accounts.company_code
// Add new suppliers here when onboarding them.
const SELLER_CODE_TO_BANK_COMPANY = {
  petbaby:    "BABI",
  yangbaobao: "CN-00016",
  // future_forwarder: "CN-XXXXX",
};

const INTERNAL_ROLES = new Set(["admin", "finance", "trader", "logistics", "boss", "internal", "platform_admin"]);

function isInternal(user) {
  return user && INTERNAL_ROLES.has(String(user.role).toLowerCase());
}

function resolveIncoterm(raw) {
  if (!raw) return null;
  let t = "";
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    t = (obj.tradeTerms || obj.trade_terms || obj.incoterm || "").toUpperCase().trim();
  } catch {
    t = String(raw).toUpperCase().trim();
  }
  // Normalise: "DDP GUANGZHOU" → "DDP"
  return t.split(/[\s,/]/)[0] || null;
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
    // ── 1. Fetch the order (include trade_terms + raw for incoterm routing) ──────
    const oRes = await pool.query(
      `SELECT id, contract_no, seller_code, company_code, trade_terms,
              raw->>'tradeTerms'  AS raw_trade_terms,
              raw->>'incoterm'    AS raw_incoterm
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
        return res.status(403).json({ error: "forbidden" });
      }
      if (!customerCodes.includes(order.company_code)) {
        return res.status(403).json({ error: "forbidden" });
      }
    }

    // ── 3. Resolve payee company code via incoterm routing ────────────────────
    // Priority: trade_terms column → raw.tradeTerms → raw.incoterm → seller_code fallback
    const rawIncoterm =
      order.trade_terms ||
      order.raw_trade_terms ||
      order.raw_incoterm ||
      null;

    const incoterm = resolveIncoterm(rawIncoterm);
    let bankCompanyCode = incoterm ? INCOTERM_TO_COMPANY[incoterm] : null;

    // Fallback: use seller_code mapping when incoterm not in table
    if (!bankCompanyCode) {
      const sellerCode = order.seller_code || "petbaby";
      bankCompanyCode  = SELLER_CODE_TO_BANK_COMPANY[sellerCode] || null;
    }

    if (!bankCompanyCode) {
      return res.status(200).json({
        success: true, data: null,
        _pending: "payee_account_not_configured",
        _debug_incoterm: incoterm,
      });
    }

    // ── 4. Fetch bank account (exact company + currency + active + default) ────
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
        _pending: `no_${currency}_account_for_${bankCompanyCode}`,
        _debug_incoterm: incoterm,
        _debug_company: bankCompanyCode,
      });
    }

    // ── 5. Return scoped fields only ──────────────────────────────────────────
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
