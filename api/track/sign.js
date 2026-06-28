// /api/track/sign.js
// POST /api/track/sign { bl, token, signature }
// Stores base64 signature to orders.raw.customer_signature

import { getPool, setCors } from "../db.js";

function specToken(bl) { try { return Buffer.from(bl + ":sanlyn2024").toString("base64"); } catch(e) { return ""; } }
function hashToken(bl, seed) { return Buffer.from(bl + ":" + (seed || "")).toString("base64url").slice(0, 24); }
function isValidToken(token, bl, shipping) {
  var raw = (typeof shipping.raw === "string") ? JSON.parse(shipping.raw || "{}") : (shipping.raw || {});
  return token === specToken(bl) || token === hashToken(bl, shipping.id) || (raw.track_token && token === raw.track_token);
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  var body = req.body || {};
  var bl = body.bl || "";
  var token = body.token || "";
  var signature = body.signature || "";
  if (!bl || !token) return res.status(400).json({ error: "bl and token required" });
  if (!signature) return res.status(400).json({ error: "signature required" });

  var pool = getPool();
  try {
    var sRes = await pool.query("SELECT * FROM shipping_agency_bookings WHERE bl_no = $1 LIMIT 1", [bl]);
    if (sRes.rowCount === 0) return res.status(404).json({ error: "提单号不存在" });

    var shipping = sRes.rows[0];
    var raw = (typeof shipping.raw === "string") ? JSON.parse(shipping.raw || "{}") : (shipping.raw || {});
    if (!isValidToken(token, bl, shipping)) return res.status(403).json({ error: "Invalid or expired link" });

    if (!shipping.contract_no) return res.status(400).json({ error: "No contract_no" });

    var oRes = await pool.query(
      "SELECT * FROM orders WHERE contract_no = $1 ORDER BY created_at DESC LIMIT 1",
      [shipping.contract_no]
    );
    if (oRes.rowCount === 0) return res.status(404).json({ error: "关联订单不存在" });

    var order = oRes.rows[0];
    var orderRaw = (typeof order.raw === "string") ? JSON.parse(order.raw || "{}") : (order.raw || {});
    orderRaw.customer_signature = signature;
    orderRaw.customer_signed_at = new Date().toISOString();

    var wfLog = Array.isArray(orderRaw.workflow_log) ? orderRaw.workflow_log : [];
    wfLog.push({ action: "signed", ts: new Date().toISOString(), by: "customer", via: "tracking_card" });
    orderRaw.workflow_log = wfLog;

    var newStatus = order.status === "delivered" ? "delivered" : "delivered";

    await pool.query(
      "UPDATE orders SET status = $1, raw = $2::jsonb, updated_at = NOW() WHERE id = $3",
      [newStatus, JSON.stringify(orderRaw), order.id]
    );

    return res.status(200).json({ ok: true, message: "签名已提交" });
  } catch (e) {
    console.error("[track/sign]", e);
    return res.status(500).json({ error: e.message });
  }
}
