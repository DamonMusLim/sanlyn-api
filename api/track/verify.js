// /api/track/verify.js
// GET /api/track/verify?bl=xxx&token=xxx
// No auth required — validates token from URL, returns shipment+order+customs data

import { getPool, setCors } from "../db.js";

function hashToken(bl, seed) {
  // Simple deterministic token: base64url of "bl:seed" — real impl uses HMAC
  return Buffer.from(bl + ":" + (seed || "")).toString("base64url").slice(0, 24);
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  var bl = req.query.bl || "";
  var token = req.query.token || "";
  if (!bl || !token) return res.status(400).json({ error: "bl and token required" });

  var pool = getPool();
  try {
    // Look up shipping record by bl_no
    var sRes = await pool.query(
      "SELECT * FROM shipping_agency_bookings WHERE bl_no = $1 LIMIT 1",
      [bl]
    );
    if (sRes.rowCount === 0) return res.status(404).json({ error: "提单号不存在" });

    var shipping = sRes.rows[0];
    var raw = (typeof shipping.raw === "string") ? JSON.parse(shipping.raw || "{}") : (shipping.raw || {});

    // Validate token: stored in raw.track_token, or generate deterministically
    var expectedToken = raw.track_token || hashToken(bl, shipping.id);
    if (token !== expectedToken) return res.status(403).json({ error: "链接无效或已过期" });

    // Find related order by contract_no or order_no
    var order = null;
    if (shipping.contract_no) {
      var oRes = await pool.query(
        "SELECT * FROM orders WHERE contract_no = $1 ORDER BY created_at DESC LIMIT 1",
        [shipping.contract_no]
      );
      if (oRes.rowCount > 0) order = oRes.rows[0];
    }

    // Find customs record
    var customs = null;
    if (shipping.contract_no) {
      var cRes = await pool.query(
        "SELECT * FROM customs_declarations WHERE contract_no = $1 ORDER BY created_at DESC LIMIT 1",
        [shipping.contract_no]
      );
      if (cRes.rowCount > 0) customs = cRes.rows[0];
    }

    // Parse raw fields
    if (order && typeof order.raw === "string") order.raw = JSON.parse(order.raw || "{}");
    if (customs && typeof customs.raw === "string") customs.raw = JSON.parse(customs.raw || "{}");
    shipping.raw = raw;

    return res.status(200).json({ shipping, order, customs });
  } catch (e) {
    console.error("[track/verify]", e);
    return res.status(500).json({ error: e.message });
  }
}
