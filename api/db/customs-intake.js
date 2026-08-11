// 录单执行器·端点: 收结构化报关JSON(非SQL), 服务端核验→事务写库→回读响应
// 核不过: intake_jobs=blocked + tasks 待办(单账本, 不建第二队列) — deep-reasoner 架构 2026-08-12
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { verifyIntake } from "./lib/customs-intake-verify.js";
import { writeIntake } from "./lib/customs-intake-write.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "POST required" });
  if (!requireAuth(req, res)) return;
  const actor = (req.user && (req.user.username || req.user.name)) || "unknown";
  const payload = req.body || {};
  const pool = getPool();
  try {
    const verify = verifyIntake(payload);

    if (!verify.ok && !payload.override_reason) {
      // 拦截: 留痕 + 任务中心待办 + 422
      const job = await pool.query(
        `INSERT INTO intake_jobs(file_sha256, doc_type, payload, verify_result, status, actor, model, created_at)
         VALUES($1,'customs_declaration',$2::jsonb,$3::jsonb,'blocked',$4,$5,now()) RETURNING id`,
        [String(payload.file_sha256 || "none"), JSON.stringify(payload), JSON.stringify(verify), actor, payload.model || "manual"]);
      const tid = `intake-${job.rows[0].id}`;
      await pool.query(
        `INSERT INTO public.tasks(id, title, reason, status, source, created_at)
         VALUES($1,$2,$3,'open','customs-intake',now()) ON CONFLICT (id) DO NOTHING`,
        [tid, `报关录入拦截 ${String((payload.doc || {}).customs_no || "?")}`, `缺口: ${verify.gaps.join("; ")}`]);
      return res.status(422).json({ success: false, blocked: true, job_id: job.rows[0].id, task_id: tid, gaps: verify.gaps });
    }

    if (!verify.ok) {
      if (String(payload.override_reason).length < 8)
        return res.status(400).json({ success: false, error: "override_reason 太短(须说明为何越过核验)" });
      if (!verify.normalized.customs_no || !(verify.normalized.total > 0))
        return res.status(400).json({ success: false, error: "缺customs_no/总额, 连override都写不了" });
    }
    const result = await writeIntake(payload, verify, actor);
    res.status(200).json({ success: true, verify: { ok: verify.ok, gaps: verify.gaps }, result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}
