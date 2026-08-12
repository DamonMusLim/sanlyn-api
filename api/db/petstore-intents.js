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
      // 三段审(Damon 0812):proposed → 店长Nora审 → mgr_ok → Claude终审 → approved → 执行器才动手
      // 老板自己在详情页点采纳的 = pending,直通(他就是终审)
      const st = String(req.query?.status || "").trim() || "pending,approved";
      const list = st.split(",").map((x) => x.trim()).filter(Boolean);
      const r = await pool.query(
        `SELECT id, product_code, product_name, channel, old_price, target_price, reason, author, status, created_at
           FROM petstore_price_intents WHERE status = ANY($1) ORDER BY created_at LIMIT 500`, [list]);
      return res.status(200).json({ success: true, data: r.rows, count: r.rowCount });
    }
    if (req.method === "POST") {
      const b = req.body || {};
      const id = Number(b.id);
      const status = String(b.status || "").trim();
      const FLOW = { proposed: ["mgr_ok", "rejected"], mgr_ok: ["approved", "rejected"],
                     approved: ["applied", "failed"], pending: ["applied", "failed", "cancelled"] };
      const ALL = ["mgr_ok", "approved", "rejected", "applied", "failed", "cancelled"];
      if (!Number.isFinite(id) || !ALL.includes(status))
        return res.status(400).json({ success: false, error: "id 必填, status ∈ " + ALL.join("/") });
      const from = Object.entries(FLOW).filter(([, to]) => to.includes(status)).map(([f]) => f);
      const done = ["applied", "failed"].includes(status);
      const r = await pool.query(
        `UPDATE petstore_price_intents SET status=$2, result=COALESCE($3,result)${done ? ", applied_at=now()" : ""}
          WHERE id=$1 AND status = ANY($4) RETURNING *`,
        [id, status, String(b.result || "").slice(0, 500) || null, from]);
      if (!r.rowCount) return res.status(409).json({ success: false, error: `指令不存在,或当前状态不允许流转到 ${status}` });
      return res.status(200).json({ success: true, data: r.rows[0] });
    }
    res.status(405).json({ success: false, error: "GET/POST only" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
