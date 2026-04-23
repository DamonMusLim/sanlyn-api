// migrate-tasks.js — P1-2: 最小任务表
//
// 设计原则（对齐 sanlyn_saas_principles.md）：
//   - 任务不是主数据，不晋升为二张核心表
//   - 详情字段放 raw JSONB，只有"频繁被查/被 join"的字段才晋升为列
//   - 任务与对象（订单 / 工厂 / 单证 / 物流）通过 (owner_object_type, owner_object_id) 多态绑定
//
// Idempotent. Trigger: curl -X POST https://api.sanlyn.cn/api/db/migrate-tasks
import { getPool, setCors } from "../db.js";

const SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id                  VARCHAR(32) PRIMARY KEY,          -- 形如 t-xxxx
  title               VARCHAR(200) NOT NULL,
  task_type           VARCHAR(32),                      -- 交期确认 / 装货安排 / 资料补齐 / 单证处理 / 审批处理 / 异常处理
  level               VARCHAR(16),                      -- order | factory | doc | logi | approve
  status              VARCHAR(24) NOT NULL DEFAULT 'open', -- open | doing | done | cancelled
  risk_level          VARCHAR(8),                       -- low | mid | high | urgent

  -- 上下文绑定（多态）
  owner_object_type   VARCHAR(16),                      -- order | factory | document | logistics
  owner_object_id     VARCHAR(64),
  owner_object_label  VARCHAR(200),                     -- 冗余显示用，避免反复 join

  -- 所属订单快照（便于 factory 按 company_code 过滤）
  related_order_no    VARCHAR(64),
  related_po_no       VARCHAR(64),
  company_code        VARCHAR(64),                      -- 归属客户（用于 tenant 过滤）

  -- 代理模式继承自关联订单
  mode                VARCHAR(16) NOT NULL DEFAULT 'owned',

  -- 截止/触发
  due_at              TIMESTAMPTZ,
  reason              TEXT,                             -- 触发原因（例: "客户 PO 逾期 3 天未响应"）

  -- 其他字段塞 raw：primary/secondary actions、steps、collaborators、state_cls 等
  raw                 JSONB DEFAULT '{}'::jsonb,

  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  closed_at           TIMESTAMPTZ
);

-- 约束
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_status_check') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
      CHECK (status IN ('open', 'doing', 'done', 'cancelled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_level_check') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_level_check
      CHECK (level IN ('order', 'factory', 'doc', 'logi', 'approve') OR level IS NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_owner_type_check') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_owner_type_check
      CHECK (owner_object_type IN ('order', 'factory', 'document', 'logistics') OR owner_object_type IS NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_mode_check') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_mode_check
      CHECK (mode IN ('owned', 'agent', 'agent_compliance'));
  END IF;
END $$;

-- 索引
CREATE INDEX IF NOT EXISTS idx_tasks_status           ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_owner            ON tasks(owner_object_type, owner_object_id);
CREATE INDEX IF NOT EXISTS idx_tasks_company_code     ON tasks(company_code);
CREATE INDEX IF NOT EXISTS idx_tasks_related_order_no ON tasks(related_order_no);
CREATE INDEX IF NOT EXISTS idx_tasks_due_at           ON tasks(due_at) WHERE status IN ('open','doing');

-- 自动 updated_at（幂等触发器）
CREATE OR REPLACE FUNCTION trg_tasks_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tasks_touch_updated_at ON tasks;
CREATE TRIGGER tasks_touch_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION trg_tasks_touch_updated_at();
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
        (SELECT COUNT(*) FROM tasks)                                    AS total,
        (SELECT COUNT(*) FROM tasks WHERE status = 'open')              AS open_tasks,
        (SELECT COUNT(*) FROM tasks WHERE status = 'doing')             AS doing_tasks,
        (SELECT COUNT(*) FROM tasks WHERE status = 'done')              AS done_tasks
    `);
    return res.status(200).json({
      success: true,
      message: "tasks table ready (min schema + JSONB raw for extensions)",
      counts: counts.rows[0],
    });
  } catch (err) {
    console.error("[migrate-tasks]", err);
    return res.status(500).json({ error: err.message });
  }
}
