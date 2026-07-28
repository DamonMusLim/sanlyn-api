// api/db/company-payment-pref.js
// PATCH /api/db/company-payment-pref
//
// Supplier preference for payment approval batching only. This does not
// execute payments or mark anything paid.

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const FINANCE_ROLES = new Set(["admin", "finance"]);

export default async function handler(req, res) {
  setCors(req, res, "PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (!FINANCE_ROLES.has(req.user?.role)) {
    return res.status(403).json({ success: false, error: "admin or finance role required" });
  }
  if (req.method !== "PATCH") {
    return res.status(405).json({ success: false, error: "PATCH only" });
  }

  const body = req.body || {};
  const companyCode = String(body.companyCode || body.company_code || "").trim();
  if (!companyCode) return res.status(400).json({ success: false, error: "companyCode required" });
  if (typeof body.consolidate !== "boolean") {
    return res.status(400).json({ success: false, error: "consolidate must be boolean" });
  }

  try {
    const pool = getPool();
    const r = await pool.query(
      `UPDATE companies
          SET payment_consolidation = $2, updated_at = NOW()
        WHERE code = $1
        RETURNING code, name_cn, name_en, payment_consolidation`,
      [companyCode, body.consolidate]
    );
    if (!r.rowCount) return res.status(404).json({ success: false, error: "company not found" });
    return res.status(200).json({ success: true, data: r.rows[0] });
  } catch (err) {
    console.error("[company-payment-pref]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
