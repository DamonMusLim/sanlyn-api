// /api/db/fix-co-account.js — One-time fix: set supplierRole and company for co account
// Also ensures filterBySupplierRole works for logistics vendors
import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const pool = getPool();
    const results = [];

    // 1. Check current co account data
    const check = await pool.query("SELECT id, username, role, raw FROM accounts WHERE username = 'co'");
    if (check.rowCount === 0) {
      return res.status(404).json({ error: "co account not found" });
    }

    const account = check.rows[0];
    const currentRaw = typeof account.raw === "string" ? JSON.parse(account.raw) : (account.raw || {});
    results.push({ step: "current", username: account.username, role: account.role, supplierRole: currentRaw.supplierRole, company: currentRaw.company });

    // 2. Update raw JSON to include supplierRole = "ocean" and company = "天津惠和国际货运代理有限公司"
    const newRaw = Object.assign({}, currentRaw, {
      supplierRole: "ocean",
      company: "天津惠和国际货运代理有限公司",
      companyName: "天津惠和国际货运代理有限公司",
    });

    await pool.query(
      "UPDATE accounts SET raw = $1 WHERE username = 'co'",
      [JSON.stringify(newRaw)]
    );
    results.push({ step: "updated", supplierRole: "ocean", company: "天津惠和国际货运代理有限公司" });

    // 3. Verify
    const verify = await pool.query("SELECT username, raw FROM accounts WHERE username = 'co'");
    const verifyRaw = typeof verify.rows[0].raw === "string" ? JSON.parse(verify.rows[0].raw) : verify.rows[0].raw;
    results.push({ step: "verified", supplierRole: verifyRaw.supplierRole, company: verifyRaw.company });

    // 4. Also check: which shipping_plans have forwarderCN containing 惠和?
    const planCheck = await pool.query(
      "SELECT shipment_no, raw->>'forwarderCN' as forwarder_cn, raw->>'shippingLine' as shipping_line FROM shipping_plans WHERE raw->>'forwarderCN' ILIKE '%惠和%' OR raw->>'shippingLine' ILIKE '%惠和%' LIMIT 20"
    );
    results.push({ step: "matching_plans", count: planCheck.rowCount, plans: planCheck.rows });

    return res.status(200).json({ success: true, results });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
