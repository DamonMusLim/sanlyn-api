// api/orders-share-links.js — POST /api/orders/:id/share-links
// 生成客户/工厂可看的时间轴分享链接，复用 magic_links(不新建token表)。
import crypto from "crypto";
import { getPool, setCors } from "./db.js";
import { requireAuth } from "./auth.js";

function rawToHash(raw) { return crypto.createHash("sha256").update(raw).digest("hex"); }
function genRaw() { return crypto.randomBytes(32).toString("hex"); }

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const pool = getPool();
  try {
    const orderId = req.params && req.params.id;
    const b = req.body || {};
    const role = b.role === "factory" ? "factory" : "customer"; // customer | factory
    if (!orderId) return res.status(400).json({ error: "缺少订单id" });

    const ordR = await pool.query(`SELECT id, order_no, contract_no FROM orders WHERE id=$1`, [orderId]);
    const order = ordR.rows[0];
    if (!order) return res.status(404).json({ error: "订单不存在" });

    const recipientRole = role === "factory" ? "order_factory_timeline" : "order_customer_timeline";
    const meta = {
      purpose: "order_timeline", order_id: order.id, order_no: order.order_no,
      contract_no: order.contract_no, role, lens: role + "_order_timeline_v1",
    };
    const raw = genRaw();
    const hash = rawToHash(raw);
    const hours = Math.min(Math.max(Number(b.expires_hours || 720), 1), 8760); // 默认30天

    const user = (req.user && (req.user.username || req.user.name)) || "system";
    await pool.query(
      `UPDATE magic_links SET revoked_at = NOW()
        WHERE recipient_role = $1 AND meta->>'order_id' = $2 AND revoked_at IS NULL`,
      [recipientRole, String(order.id)]);
    await pool.query(
      `INSERT INTO magic_links (token_hash, recipient_role, meta, expires_at, access_log, created_at, created_by)
       VALUES ($1, $2, $3::jsonb, NOW() + ($4 || ' hours')::interval, '[]'::jsonb, NOW(), $5)`,
      [hash, recipientRole, JSON.stringify(meta), String(hours), user]);

    const base = process.env.ORDER_TIMELINE_SHARE_BASE || "https://sanlyn.cn/public/order-timeline-share.html";
    return res.json({ success: true, url: `${base}?token=${encodeURIComponent(raw)}`, role, expires_hours: hours });
  } catch (e) {
    console.error("[orders-share-links]", e.message);
    return res.status(500).json({ error: "internal: " + e.message });
  }
}
