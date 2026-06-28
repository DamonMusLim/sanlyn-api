// api/db/etd-delay-notify.js
// POST /api/db/etd-delay-notify
//   body: { order_no, customer, old_etd, new_etd }
//   1. Appends etd_history to orders.raw
//   2. Sends WeCom webhook notification

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

async function notifyWecom({ order_no, customer, old_etd, new_etd }) {
  const url = process.env.WECOM_WEBHOOK_URL;
  if (!url) return { skipped: true };
  const content = [
    `⚠ ETD 延期通知`,
    `**订单**: \`${order_no}\``,
    `**客户**: ${customer || "—"}`,
    `**原 ETD**: ${old_etd}`,
    `**新 ETD**: ${new_etd}`,
  ].join("\n");
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "markdown", markdown: { content } }),
    });
    return { ok: true };
  } catch (e) {
    console.error("[etd-delay-notify] wecom failed:", e.message);
    return { ok: false, error: e.message };
  }
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { order_no, customer, old_etd, new_etd } = req.body || {};
  if (!order_no || !old_etd || !new_etd)
    return res.status(400).json({ error: "order_no, old_etd, new_etd required" });

  const pool = getPool();

  try {
    // 1. Append to etd_history in orders.raw
    await pool.query(
      `UPDATE orders
       SET raw = jsonb_set(
         COALESCE(raw, '{}'::jsonb),
         '{etd_history}',
         COALESCE(raw->'etd_history', '[]'::jsonb) || $1::jsonb
       ),
       updated_at = NOW()
       WHERE order_no = $2`,
      [
        JSON.stringify({ old_etd, new_etd, changed_at: new Date().toISOString() }),
        order_no,
      ]
    );

    // 2. WeCom notification (fire-and-forget, don't fail main flow)
    const wecom = await notifyWecom({ order_no, customer, old_etd, new_etd });

    return res.json({ success: true, wecom });
  } catch (err) {
    console.error("[etd-delay-notify]", err.message);
    return res.status(500).json({ error: err.message });
  }
}
