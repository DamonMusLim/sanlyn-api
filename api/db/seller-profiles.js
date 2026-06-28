// /api/db/seller-profiles  — GET list of all issuing company profiles
// Used by OrdersModule (admin) to populate the SELLER dropdown.
//
// BANK-ACCOUNT-PAYEE-MINIMAL-FIX-001:
//   customer role → 403. Bank account data must be fetched via
//   /api/db/order-payee-account (order-scoped, customer-safe).
//   seller_profiles contains legal entity + bank account data that
//   must not be listed freely to external users.

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const INTERNAL_ROLES = new Set(["admin", "finance", "trader", "logistics", "boss", "internal", "platform_admin"]);

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  // BANK-ACCOUNT-PAYEE-MINIMAL-FIX-001: lock to internal roles only
  const role = String((req.user && req.user.role) || "").toLowerCase();
  if (!INTERNAL_ROLES.has(role)) {
    return res.status(403).json({ error: "forbidden", detail: "seller profiles are internal only" });
  }

  const pool = getPool();
  try {
    const r = await pool.query(
      `SELECT code, name_en, name_cn, address, tel, email,
              bank_name, bank_name_cn, bank_swift, bank_addr, usd_account, rmb_account, tax_no, is_default
       FROM seller_profiles ORDER BY is_default DESC, code`
    );
    res.json({ success: true, data: r.rows, count: r.rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
