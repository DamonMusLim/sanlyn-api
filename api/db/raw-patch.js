// api/db/raw-patch.js — Admin-only: patch shipping_plans.raw fields
// POST { shipmentNo, patches: { key: value, ... } }
import { getPool, setCors } from "../db.js";

const ALLOWED_KEYS = [
  "eta", "etd", "blNo", "vessel", "voyage", "containerNo", "sealNo",
  "pol", "pod", "notes", "orderNos", "order_contract_nos",
  "freightSaleUSD", "portSurchargeTotal", "exchangeRate",
];

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Forbidden: admin only" });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const pool = getPool();
    const { shipmentNo, patches } = req.body;
    if (!shipmentNo || !patches) {
      return res.status(400).json({ success: false, error: "shipmentNo and patches required" });
    }
    const badKeys = Object.keys(patches).filter(k => !ALLOWED_KEYS.includes(k));
    if (badKeys.length) {
      return res.status(400).json({ success: false, error: "Disallowed keys: " + badKeys.join(", ") });
    }
    const results = [];
    for (const [key, val] of Object.entries(patches)) {
      const r = await pool.query(
        `UPDATE shipping_plans SET raw = jsonb_set(COALESCE(raw, '{}'), $1, $2::jsonb), updated_at = NOW() WHERE shipment_no = $3 RETURNING shipment_no`,
        ['{' + key + '}', JSON.stringify(val), shipmentNo]
      );
      results.push({ key, updated: r.rowCount > 0 });
    }
    return res.status(200).json({ success: true, shipmentNo, results });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
