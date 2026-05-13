// /api/db/order-payee-account
// BANK-ACCOUNT-PAYEE-MINIMAL-FIX-001
//
// GET /api/db/order-payee-account?orderId=<id>&currency=<USD|CNY>
//
// Returns the payee bank account for an order.
// The payee is determined by whichever company was SELECTED on the order
// (issuing_company / seller_code), NOT inferred from incoterm.
//
// ── HOW TO ADD A NEW COMPANY ─────────────────────────────────────────────────
// 1. INSERT INTO bank_accounts
//      (company_code, currency, account_holder, bank_name, bank_name_en,
//       account_no, swift, bank_address, active, is_default)
//    VALUES ('YOUR-CODE', 'USD', '...', ..., true, true);
//    (repeat for CNY if needed)
//
// 2. Add entry to ISSUING_COMPANY_MAP below so the order field value
//    maps to your new company_code.
//
// 3. When creating orders, set issuing_company or seller_code to one of
//    the keys in ISSUING_COMPANY_MAP.
// ─────────────────────────────────────────────────────────────────────────────

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// Maps every known value of orders.issuing_company / orders.seller_code
// → bank_accounts.company_code
//
// Add a row here whenever you onboard a new issuing entity.
const ISSUING_COMPANY_MAP = {
  // ── 厦门巴匕出口有限公司 ──────────────────────────────────────
  "BABI":                       "BABI",
  "petbaby":                    "BABI",
  "XIAMEN PET BABY":            "BABI",
  "XIAMEN PET BABY IMPORT AND EXPORT CO., LTD": "BABI",
  "xiamen pet baby":            "BABI",

  // ── 上海洋贝国际物流有限公司 ──────────────────────────────────
  "CN-00016":                   "CN-00016",
  "yangbaobao":                 "CN-00016",
  "YANGBAOBAO":                 "CN-00016",
  "上海洋贝":                   "CN-00016",
  "Shanghai Ocean Baby":        "CN-00016",
  "SHANGHAI OCEAN BABY":        "CN-00016",

  // ── future company example ────────────────────────────────────
  // "MY-NEW-COMPANY":          "CN-XXXXX",
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

  if (!orderId) return res.status(400).json({ error: "orderId required" });
  if (!["USD", "CNY"].includes(currency)) return res.status(400).json({ error: "currency must be USD or CNY" });

  const pool = getPool();

  try {
    // ── 1. Fetch order — include all issuing company fields ───────────────────
    const oRes = await pool.query(
      `SELECT id, contract_no, company_code,
              seller_code,
              issuing_company,
              issuing_company_en,
              raw->>'seller'      AS raw_seller,
              raw->>'sellerName'  AS raw_seller_name,
              raw->>'sellerCode'  AS raw_seller_code
         FROM orders WHERE id = $1 LIMIT 1`,
      [orderId]
    );
    const order = oRes.rows[0];
    if (!order) return res.status(404).json({ error: "order_not_found" });

    // ── 2. Customer scope guard ───────────────────────────────────────────────
    if (!isInternal(user)) {
      const customerCodes = user.companyCodes || (user.company_code ? [user.company_code] : []);
      if (!customerCodes.length) return res.status(403).json({ error: "forbidden" });
      if (!customerCodes.includes(order.company_code)) return res.status(403).json({ error: "forbidden" });
    }

    // ── 3. Resolve which company was selected on this order ───────────────────
    // Try each field in priority order — whichever is set first wins.
    const candidates = [
      order.issuing_company_en,
      order.issuing_company,
      order.seller_code,
      order.raw_seller_code,
      order.raw_seller_name,
      order.raw_seller,
    ];

    let bankCompanyCode = null;
    for (const candidate of candidates) {
      if (!candidate) continue;
      const key = String(candidate).trim();
      // Exact match first, then case-insensitive
      bankCompanyCode = ISSUING_COMPANY_MAP[key]
        || ISSUING_COMPANY_MAP[key.toLowerCase()]
        || ISSUING_COMPANY_MAP[key.toUpperCase()]
        || null;
      if (bankCompanyCode) break;
    }

    if (!bankCompanyCode) {
      return res.status(200).json({
        success: true, data: null,
        _pending: "issuing_company_not_set_or_not_mapped",
        _debug_candidates: candidates.filter(Boolean),
      });
    }

    // ── 4. Fetch bank account ─────────────────────────────────────────────────
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
