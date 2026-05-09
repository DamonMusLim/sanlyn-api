// /api/track/confirm.js
// POST /api/track/confirm { bl, token }
// Customer confirms delivery — updates orders.status = 'delivered'

import { getPool, setCors } from "../db.js";

function hashToken(bl, seed) {
  return Buffer.from(bl + ":" + (seed || "")).toString("base64url").slice(0, 24);
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  var body = req.body || {};
  var bl = body.bl || "";
  var token = body.token || "";
  if (!bl || !token) return res.status(400).json({ error: "bl and token required" });

  var pool = getPool();
  try {
    var sRes = await pool.query("SELECT * FROM shipping_agency_bookings WHERE bl_no = $1 LIMIT 1", [bl]);
    if (sRes.rowCount === 0) return res.status(404).json({ error: "提单号不存在" });

    var shipping = sRes.rows[0];
    var raw = (typeof shipping.raw === "string") ? JSON.parse(shipping.raw || "{}") : (shipping.raw || {});
    var expectedToken = raw.track_token || hashToken(bl, shipping.id);
    if (token !== expectedToken) return res.status(403).json({ error: "链接无效" });

    if (!shipping.contract_no) return res.status(400).json({ error: "No contract_no on shipping record" });

    // Get order
    var oRes = await pool.query(
      "SELECT * FROM orders WHERE contract_no = $1 ORDER BY created_at DESC LIMIT 1",
      [shipping.contract_no]
    );
    if (oRes.rowCount === 0) return res.status(404).json({ error: "关联订单不存在" });

    var order = oRes.rows[0];
    var orderRaw = (typeof order.raw === "string") ? JSON.parse(order.raw || "{}") : (order.raw || {});
    var wfLog = Array.isArray(orderRaw.workflow_log) ? orderRaw.workflow_log : [];
    wfLog.push({ action: "delivered", ts: new Date().toISOString(), by: "customer", via: "tracking_card" });
    orderRaw.workflow_log = wfLog;
    orderRaw.customer_confirmed_at = new Date().toISOString();

    await pool.query(
      "UPDATE orders SET status = $1, raw = $2::jsonb, updated_at = NOW() WHERE id = $3",
      ["delivered", JSON.stringify(orderRaw), order.id]
    );

    return res.status(200).json({ ok: true, message: "收货已确认" });
  } catch (e) {
    console.error("[track/confirm]", e);
    return res.status(500).json({ error: e.message });
  }
}
