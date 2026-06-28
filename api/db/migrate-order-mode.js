// migrate-order-mode.js — P1-1: 给 orders 表加 mode 字段（代理模式判定）
//
// 字段设计：
//   orders.mode VARCHAR(16) NOT NULL DEFAULT 'owned'
//   CHECK (mode IN ('owned', 'agent', 'agent_compliance'))
//
// 回填策略（保守）：
//   - 所有行默认 'owned'
//   - 不自动把 raw.factoryCompanyCode 存在的行判成 agent（规则太粗，易误判）
//   - agent 晋升留给后续人工 / 规则脚本 / 管理后台按单设置
//
// 'agent_compliance' 目前不使用，仅预留结构，用于后续食品/强合规例外审批通过后的晋升态
//
// Idempotent. Trigger: curl -X POST https://api.sanlyn.cn/api/db/migrate-order-mode
import { getPool, setCors } from "../db.js";

const SQL = `
-- ── 1) 加 mode 列（幂等）──
ALTER TABLE orders ADD COLUMN IF NOT EXISTS mode VARCHAR(16) NOT NULL DEFAULT 'owned';

-- ── 2) 加 CHECK 约束（幂等）──
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_mode_check'
  ) THEN
    ALTER TABLE orders ADD CONSTRAINT orders_mode_check
      CHECK (mode IN ('owned', 'agent', 'agent_compliance'));
  END IF;
END $$;

-- ── 3) 索引（按 mode 查询，例如统计代理单量）──
CREATE INDEX IF NOT EXISTS idx_orders_mode ON orders(mode);

-- ── 4) 不做任何数据回填。所有行保持 DEFAULT 'owned'，包括新行 ──
-- agent 晋升由人工 / 后续规则脚本显式执行，例如：
--   UPDATE orders SET mode='agent' WHERE id IN (...);
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
        (SELECT COUNT(*) FROM orders)                              AS total_orders,
        (SELECT COUNT(*) FROM orders WHERE mode = 'owned')         AS mode_owned,
        (SELECT COUNT(*) FROM orders WHERE mode = 'agent')         AS mode_agent,
        (SELECT COUNT(*) FROM orders WHERE mode = 'agent_compliance') AS mode_agent_compliance
    `);
    return res.status(200).json({
      success: true,
      message: "orders.mode column ready (values: owned | agent | agent_compliance)",
      counts: counts.rows[0],
      note: "All rows default to 'owned'. Promote to 'agent' manually per-order.",
    });
  } catch (err) {
    console.error("[migrate-order-mode]", err);
    return res.status(500).json({ error: err.message });
  }
}
