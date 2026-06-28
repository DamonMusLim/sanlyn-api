// /api/db/shipping-notify.js
// POST /api/db/shipping-notify?id=<shipping_plans.id>
// Manual trigger for dual-track shipment notifications (customer + factory).
// Supports ?force=1 to re-send even if already sent.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { sendShipmentNotifications } from "../../jobs/shipment-notify.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { id, force } = req.query;
  if (!id) return res.status(400).json({ error: "id query param required" });

  const pool = getPool();
  let row;
  try {
    const r = await pool.query("SELECT * FROM shipping_plans WHERE id = $1", [id]);
    row = r.rows[0];
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  if (!row) return res.status(404).json({ error: "shipment not found" });
  if (!row.bl_no) return res.status(400).json({ error: "BL No not set — cannot send notifications yet" });

  try {
    const result = await sendShipmentNotifications(pool, row, { force: force === "1" || force === "true" });
    return res.status(200).json({ success: true, result });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
