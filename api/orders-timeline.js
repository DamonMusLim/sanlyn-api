// api/orders-timeline.js — GET /api/orders/:id/timeline (内部,完整时间轴)
import { getPool, setCors } from "./db.js";
import { requireAuth } from "./auth.js";
import { buildOrderTimeline } from "./lib/order-timeline-core.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const pool = getPool();
  try {
    const orderId = req.params && req.params.id;
    if (!orderId) return res.status(400).json({ error: "缺少订单id" });
    const result = await buildOrderTimeline(pool, orderId, { viewerRole: "internal" });
    if (!result) return res.status(404).json({ error: "订单不存在" });
    return res.json({ success: true, ...result });
  } catch (e) {
    console.error("[orders-timeline]", e.message);
    return res.status(500).json({ error: "internal: " + e.message });
  }
}
