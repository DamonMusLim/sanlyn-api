// api/public-order-timeline.js — GET /api/public/order-timeline?token=... (对外,fail-closed)
// 客户/工厂用 magic_links token 看裁剪版时间轴:只有进度节点+对应可见日记,不含金额/内部通知/邮件记录。
import crypto from "crypto";
import { getPool, setCors } from "./db.js";
import { buildOrderTimeline } from "./lib/order-timeline-core.js";

function rawToHash(raw) { return crypto.createHash("sha256").update(raw).digest("hex"); }

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const pool = getPool();
  try {
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: "缺少token" });
    const hash = rawToHash(String(token));

    const linkR = await pool.query(
      `SELECT id, recipient_role, meta FROM magic_links
        WHERE token_hash=$1
          AND recipient_role IN ('order_customer_timeline','order_factory_timeline')
          AND expires_at > NOW() AND revoked_at IS NULL
        LIMIT 1`, [hash]);
    const link = linkR.rows[0];
    if (!link) return res.status(403).json({ error: "链接无效或已过期" });

    const meta = link.meta || {};
    const role = meta.role === "factory" ? "factory" : "customer";
    const orderId = meta.order_id;
    if (!orderId) return res.status(403).json({ error: "链接数据异常" });

    // 访问留痕(不阻断)
    pool.query(`UPDATE magic_links SET access_log = access_log || $2::jsonb, used_at = NOW() WHERE id=$1`,
      [link.id, JSON.stringify([{ at: new Date().toISOString(), ip: req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null }])]
    ).catch(() => {});

    const result = await buildOrderTimeline(pool, orderId, { viewerRole: role });
    if (!result) return res.status(404).json({ error: "订单不存在" });
    return res.json({ success: true, viewer: { role }, ...result });
  } catch (e) {
    console.error("[public-order-timeline]", e.message);
    return res.status(500).json({ error: "internal: " + e.message });
  }
}
