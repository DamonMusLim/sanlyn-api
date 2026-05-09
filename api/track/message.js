// /api/track/message.js
// POST /api/track/message { bl, token, message }
// Sends WeCom notification to Damon / ops team

import { getPool, setCors } from "../db.js";

function specToken(bl) { try { return Buffer.from(bl + ":sanlyn2024").toString("base64"); } catch(e) { return ""; } }
function hashToken(bl, seed) { return Buffer.from(bl + ":" + (seed || "")).toString("base64url").slice(0, 24); }
function isValidToken(token, bl, shipping) {
  var raw = (typeof shipping.raw === "string") ? JSON.parse(shipping.raw || "{}") : (shipping.raw || {});
  return token === specToken(bl) || token === hashToken(bl, shipping.id) || (raw.track_token && token === raw.track_token);
}

var WECOM_WEBHOOK = process.env.WECOM_WEBHOOK_URL || "";

async function sendWecom(text) {
  if (!WECOM_WEBHOOK) { console.warn("[track/message] no WECOM_WEBHOOK_URL"); return; }
  try {
    await fetch(WECOM_WEBHOOK, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msgtype: "markdown",
        markdown: { content: text },
      }),
    });
  } catch (e) {
    console.error("[track/message] wecom send failed:", e.message);
  }
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  var body = req.body || {};
  var bl = body.bl || "";
  var token = body.token || "";
  var message = (body.message || "").trim();
  if (!bl || !token) return res.status(400).json({ error: "bl and token required" });
  if (!message) return res.status(400).json({ error: "message required" });

  var pool = getPool();
  try {
    var sRes = await pool.query("SELECT * FROM shipping_agency_bookings WHERE bl_no = $1 LIMIT 1", [bl]);
    if (sRes.rowCount === 0) return res.status(404).json({ error: "提单号不存在" });

    var shipping = sRes.rows[0];
    var raw = (typeof shipping.raw === "string") ? JSON.parse(shipping.raw || "{}") : (shipping.raw || {});
    if (!isValidToken(token, bl, shipping)) return res.status(403).json({ error: "Invalid or expired link" });

    // Send WeCom notification
    var wecomText = [
      "## 📣 客户来消息了",
      "**提单号:** " + bl,
      "**客户:** " + (shipping.consignee || shipping.shipper || "未知"),
      "**内容:** " + message,
      "**时间:** " + new Date().toLocaleString("zh-CN"),
    ].join("\n");
    await sendWecom(wecomText);

    // Store message in shipping raw
    var msgs = Array.isArray(raw.customer_messages) ? raw.customer_messages : [];
    msgs.push({ ts: new Date().toISOString(), message: message });
    raw.customer_messages = msgs;
    await pool.query(
      "UPDATE shipping_agency_bookings SET raw = $1::jsonb, updated_at = NOW() WHERE id = $2",
      [JSON.stringify(raw), shipping.id]
    );

    return res.status(200).json({ ok: true, message: "消息已发送" });
  } catch (e) {
    console.error("[track/message]", e);
    return res.status(500).json({ error: e.message });
  }
}
