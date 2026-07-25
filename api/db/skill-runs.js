import { getPool, setCors } from "../db.js";
import { requireAuth }      from "../auth.js";

// skill_runs — AI 技能运行日志(内部运营元数据)。GET 列出/按 skill 过滤;POST 追加一条。
// 数据非敏感(技能名/模型/时间/摘要),但仅内部角色可见。表见 migration skill_runs。
export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const role = req.user?.role || "customer";
  const isInternal = ["admin", "finance", "logistics", "boss", "owner"].includes(role);
  if (!isInternal) return res.status(403).json({ error: "internal only" });

  const pool = getPool();

  if (req.method === "POST") {
    const b = req.body || {};
    if (!b.skill_name) return res.status(400).json({ error: "skill_name required" });
    const { rows } = await pool.query(
      `INSERT INTO skill_runs
         (skill_name, model, started_at, ended_at, duration_ms, summary, ticket_ref, status)
       VALUES ($1,$2,COALESCE($3::timestamptz, now()),$4,$5,$6,$7,COALESCE($8,'ok'))
       RETURNING *`,
      [b.skill_name, b.model || null, b.started_at || null, b.ended_at || null,
       b.duration_ms || null, b.summary || null, b.ticket_ref || null, b.status || null]
    );
    return res.json({ ok: true, row: rows[0] });
  }

  // GET — recent runs, optional ?skill= filter, ?limit=
  const skill = req.query?.skill;
  const limit = Math.min(parseInt(req.query?.limit, 10) || 300, 1000);
  const params = [];
  let where = "";
  if (skill) { params.push(skill); where = "WHERE skill_name = $1"; }
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT id, skill_name, model, started_at, ended_at, duration_ms, summary, ticket_ref, status
       FROM skill_runs ${where}
      ORDER BY started_at DESC
      LIMIT $${params.length}`,
    params
  );
  return res.json({ rows });
}
