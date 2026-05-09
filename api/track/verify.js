// /api/track/verify.js
// GET /api/track/verify?bl=xxx&token=xxx
// No auth required — validates token from URL, returns shipment+order+customs data

import { getPool, setCors } from "../db.js";

// Spec token: btoa(bl_no + ':sanlyn2024')
function specToken(bl) {
  try { return Buffer.from(bl + ":sanlyn2024").toString("base64"); } catch(e) { return ""; }
}

function hashToken(bl, seed) {
  // Legacy: base64url of "bl:seed"
  return Buffer.from(bl + ":" + (seed || "")).toString("base64url").slice(0, 24);
}

function isValidToken(token, bl, shipping) {
  if (!token) return false;
  var raw = (typeof shipping.raw === "string") ? JSON.parse(shipping.raw || "{}") : (shipping.raw || {});
  // 1. Stored custom token
  if (raw.track_token && token === raw.track_token) return true;
  // 2. Spec token: btoa(bl + ':sanlyn2024')
  if (token === specToken(bl)) return true;
  // 3. Legacy hashToken
  if (token === hashToken(bl, shipping.id)) return true;
  return false;
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

    // Validate token
    if (!isValidToken(token, bl, shipping)) {
      return res.status(200).json({ authorized: false, error: "Link invalid or expired" });
    }

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

    return res.status(200).json({
      authorized: true,
      order: order ? {
        order_no: order.order_no,
        customer: order.customer,
        status:   order.status,
        etd:      order.etd,
        total_amount: order.total_amount,
        currency: order.currency,
      } : null,
      shipping: {
        vessel:       shipping.vessel,
        pol:          shipping.pol,
        pod:          shipping.pod,
        etd:          shipping.etd,
        eta:          shipping.eta,
        bl_no:        shipping.bl_no,
        container_no: shipping.container_no,
        voyage:       shipping.voyage,
        flow_status:  shipping.flow_status,
        trucking_cn:  shipping.trucking_cn || raw.trucking_cn,
        driver_contact: raw.driver_contact,
        raw:          raw,
      },
      customs: customs ? {
        declaration_no:   customs.declaration_no,
        declaration_date: customs.declare_date || customs.declaration_date,
        status:           customs.status || customs.customs_status,
        hs_codes:         customs.hs_codes,
        raw:              customs.raw,
      } : null,
    });
  } catch (e) {
    console.error("[track/verify]", e);
    return res.status(500).json({ error: e.message });
  }
}
