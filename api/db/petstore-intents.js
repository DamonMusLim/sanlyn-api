// 待执行改价指令:GET 取 pending / POST 回写执行结果
// 闭环的中段:老板在详情页点采纳 → 这里排队 → Studio 每5分钟取走执行 → 回写状态
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  try {
    if (req.method === "GET") {
      const r = await pool.query(
        `SELECT id, product_code, product_name, channel, old_price, target_price, reason, author, created_at
           FROM petstore_price_intents WHERE status='pending' ORDER BY created_at LIMIT 200`);
      return res.status(200).json({ success: true, data: r.rows, count: r.rowCount });
    }
    if (req.method === "POST") {
      const b = req.body || {};
      const id = Number(b.id);
      const status = String(b.status || "").trim();
      if (!Number.isFinite(id) || !["applied", "failed", "cancelled"].includes(status))
        return res.status(400).json({ success: false, error: "id 必填, status ∈ applied/failed/cancelled" });
      const r = await pool.query(
        `UPDATE petstore_price_intents SET status=$2, result=$3, applied_at=now()
          WHERE id=$1 AND status='pending' RETURNING *`, [id, status, String(b.result || "").slice(0, 500)]);
      if (!r.rowCount) return res.status(409).json({ success: false, error: "指令不存在或已处理" });
      return res.status(200).json({ success: true, data: r.rows[0] });
    }
    res.status(405).json({ success: false, error: "GET/POST only" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
