// /api/db/seller-profiles  — GET list of all issuing company profiles
// Used by OrdersModule to populate the SELLER dropdown
// Shape: [{ code, name_en, name_cn, address, tel, email, bank_name, bank_swift, usd_account, rmb_account, is_default }]

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const pool = getPool();
  try {
    const r = await pool.query(
      `SELECT code, name_en, name_cn, address, tel, email,
              bank_name, bank_swift, bank_addr, usd_account, rmb_account, is_default
       FROM seller_profiles ORDER BY is_default DESC, code`
    );
    res.json({ success: true, data: r.rows, count: r.rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
