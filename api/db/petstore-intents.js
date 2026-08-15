// 待执行改价指令:GET 取 pending / POST 回写执行结果
// 闭环的中段:老板在详情页点采纳 → 这里排队 → Studio 每5分钟取走执行 → 回写状态
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { reportFailure } from "./lib/report-failure.mjs";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  try {
    // 超时清理:proposed/mgr_ok 挂太久 → stale;applying 卡住 → 退回 approved 让下一轮重试
    // (codex 0812:「proposed 放三天没人审」「调完接口崩了只靠本地状态恢复不了」)
    await pool.query(`UPDATE petstore_price_intents SET status='stale',
        result=COALESCE(result,'')||' [超时未审,自动作废]'
       WHERE status IN ('proposed','mgr_ok') AND created_at < now() - interval '3 days'`).catch(() => {});
    await pool.query(`UPDATE petstore_price_intents SET status='approved',
        result=COALESCE(result,'')||' [执行中断,退回重试]'
       WHERE status='applying' AND claimed_at < now() - interval '15 minutes'`).catch(() => {});

    // 原子认领:执行器专用,一次拿走一批并置 applying,别的 worker 就抢不到了
    if (req.method === "POST" && String(req.body?.action || "") === "claim") {
      const worker = String(req.body?.worker || "unknown").slice(0, 40);
      const lim = Math.min(Number(req.body?.limit) || 50, 200);
      const r = await pool.query(
        `UPDATE petstore_price_intents SET status='applying', worker_id=$1, claimed_at=now()
          WHERE id IN (SELECT id FROM petstore_price_intents
                        WHERE status IN ('pending','approved')
                        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $2)
        RETURNING id, product_code, product_name, channel, old_price, target_price, reason, author, status`,
        [worker, lim]);
      return res.status(200).json({ success: true, data: r.rows, count: r.rowCount });
    }

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
                     approved: ["applied", "failed", "applying"], pending: ["applied", "failed", "cancelled", "applying"],
                     applying: ["applied", "failed", "approved"] };
      const ALL = ["mgr_ok", "approved", "rejected", "applied", "failed", "cancelled", "applying", "stale"];
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
    await reportFailure("petstore-intents", err, {
      impact: "定价意图认领/回写失败，可能导致改价管线静默卡住",
      method: req.method,
      action: req.body?.action || null,
    }, { pool });
    res.status(500).json({ success: false, error: err.message });
  }
}
