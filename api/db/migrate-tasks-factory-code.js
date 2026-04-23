// migrate-tasks-factory-code.js — BUG-A fix
//
// 给 tasks 和 collaboration_threads 加 factory_company_code 列。
// 原因：factory 账号的 JWT.companyCode 是 "FAC-XXXXXX"（工厂自身码），
// 而 admin 发任务时 company_code 填的是客户的 "CN-XXXXX"。
// 没有 factory_company_code 就无法让工厂看到自己要处理的任务。
//
// 与 orders 表的三字段过滤逻辑对齐 (参见 /api/db/orders.js 的 company_codes 匹配)。
//
// Idempotent. Trigger: curl -X POST https://api.sanlyn.cn/api/db/migrate-tasks-factory-code
import { getPool, setCors } from "../db.js";

const SQL = `
ALTER TABLE tasks                  ADD COLUMN IF NOT EXISTS factory_company_code VARCHAR(64);
ALTER TABLE collaboration_threads  ADD COLUMN IF NOT EXISTS factory_company_code VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_tasks_factory_company_code    ON tasks(factory_company_code)                 WHERE factory_company_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_collab_threads_factory_code   ON collaboration_threads(factory_company_code) WHERE factory_company_code IS NOT NULL;
`;

export default async function handler(req, res) {
  setCors(req, res, "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!["POST", "GET"].includes(req.method)) return res.status(405).json({ error: "POST or GET only" });

  try {
    const pool = getPool();
    await pool.query(SQL);
    const counts = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM tasks)                                            AS tasks_total,
        (SELECT COUNT(*) FROM tasks WHERE factory_company_code IS NOT NULL)     AS tasks_with_factory_code,
        (SELECT COUNT(*) FROM collaboration_threads)                            AS threads_total,
        (SELECT COUNT(*) FROM collaboration_threads WHERE factory_company_code IS NOT NULL) AS threads_with_factory_code
    `);
    return res.status(200).json({
      success: true,
      message: "tasks + collaboration_threads now have factory_company_code",
      counts: counts.rows[0],
      note: "New column is NULL for existing rows; fill via /api/tasks/create or manual backfill.",
    });
  } catch (err) {
    console.error("[migrate-tasks-factory-code]", err);
    return res.status(500).json({ error: err.message });
  }
}
