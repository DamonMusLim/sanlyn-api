// migrate-ai-and-notifications.js
//
// 一次性建立 3 张表：
//   1) ai_operations     - AI 每次动作的"日记"（输入/输出/置信/人工修正 diff）
//   2) ai_summaries      - AI 周期性"总结"（订单完结 / 月报 / 异常事件）
//   3) notifications     - 系统收件箱（所有推送先入库再投递企微/邮件，避免企微刷屏丢失）
//
// 设计原则：
//   - 日记记录足够细粒度（用于反查和训练数据）
//   - 总结是 rollup，定期 cron 生成
//   - 通知是聚合层，每个月报既写 ai_summaries 也写 notifications，触发企微 + 任务
//
// Idempotent. Trigger:
//   curl -X POST https://api.sanlyn.cn/api/db/migrate-ai-and-notifications
//
import { getPool, setCors } from "../db.js";

const SQL = `
-- ═══════════════════════════════════════════════════════════════
-- 1) ai_operations — AI 动作日记
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS ai_operations (
  id              BIGSERIAL PRIMARY KEY,
  order_id        INT,
  collab_sheet_id BIGINT,
  doc_type        VARCHAR(64),       -- customs_draft | bl_preview | telex_log_template | hs_classify | urge_decision ...
  action          VARCHAR(32),       -- generate | validate | classify | extract | recommend | summarize
  model           VARCHAR(64),       -- claude-sonnet-4-6 | gpt-4o | minimax-ocr ...
  input_hash      VARCHAR(64),       -- 输入数据 SHA-256 指纹（去重）
  input_data      JSONB,             -- 实际输入
  output_data     JSONB,             -- AI 产出
  confidence      NUMERIC(4,3),      -- 0.000 - 1.000
  reasoning       TEXT,              -- AI 简要解释
  triggered_by    VARCHAR(64),       -- 'system' | user_id
  result          VARCHAR(24) DEFAULT 'pending',  -- pending | accepted | edited | rejected | overridden
  human_diff      JSONB,             -- 人工修正的字段级 diff
  reviewer_id     VARCHAR(64),
  reviewed_at     TIMESTAMPTZ,
  cost_tokens     INT,               -- 大约花的 token 数（成本核算）
  duration_ms     INT,               -- 耗时
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_ops_order ON ai_operations(order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_ops_doctype ON ai_operations(doc_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_ops_result ON ai_operations(result) WHERE result IN ('pending','rejected');
CREATE INDEX IF NOT EXISTS idx_ai_ops_input_hash ON ai_operations(input_hash);


-- ═══════════════════════════════════════════════════════════════
-- 2) ai_summaries — 周期总结
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS ai_summaries (
  id              BIGSERIAL PRIMARY KEY,
  scope           VARCHAR(24),       -- order | customer | factory | global | doc_type
  scope_id        VARCHAR(64),       -- order_id / customer_code / factory_code / 'all'
  scope_label     VARCHAR(120),      -- 显示名（冗余，避免 join）
  period_start    DATE,
  period_end      DATE,
  summary_type    VARCHAR(24),       -- order_complete | monthly | weekly | incident | quarterly
  metrics         JSONB,             -- {accuracy, avg_resolution_h, top_errors, totals, ...}
  highlights      TEXT,              -- AI 写的中文人类可读总结
  recommendations JSONB,             -- AI 改进建议数组
  diff_vs_prev    JSONB,             -- 对比上个周期
  generated_by    VARCHAR(64),       -- 用哪个 model 生成
  read_by         JSONB DEFAULT '{}'::jsonb,  -- {user_id: 'YYYY-MM-DD HH:MM'}
  archived_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_sum_scope ON ai_summaries(scope, scope_id, period_end DESC);
CREATE INDEX IF NOT EXISTS idx_ai_sum_type_recent ON ai_summaries(summary_type, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_sum_period ON ai_summaries(scope, scope_id, summary_type, period_start, period_end);


-- ═══════════════════════════════════════════════════════════════
-- 3) notifications — 系统收件箱
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS notifications (
  id                BIGSERIAL PRIMARY KEY,
  type              VARCHAR(32),     -- ai_summary | overdue | urge | incident | finance_alert | system
  level             VARCHAR(12) DEFAULT 'info',  -- info | warn | urgent
  title             VARCHAR(200),
  body              TEXT,
  payload           JSONB,           -- 结构化数据
  scope             VARCHAR(24),     -- order | customer | factory | global
  scope_id          VARCHAR(64),
  recipients        TEXT[],          -- user_id 数组
  recipient_roles   TEXT[],          -- 角色数组
  channels          TEXT[] DEFAULT ARRAY['inapp'], -- 实际投递渠道
  delivery_status   JSONB DEFAULT '{}'::jsonb,    -- {wecom:'sent', email:'pending'}
  read_by           JSONB DEFAULT '{}'::jsonb,
  pinned_by         TEXT[],
  archived_at       TIMESTAMPTZ,
  related_op        BIGINT,          -- → ai_operations.id
  related_summary   BIGINT,          -- → ai_summaries.id
  related_task      VARCHAR(32),     -- → tasks.id
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notif_recipient ON notifications USING GIN (recipients);
CREATE INDEX IF NOT EXISTS idx_notif_scope ON notifications(scope, scope_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_unread ON notifications(archived_at, created_at DESC) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notif_type ON notifications(type, created_at DESC);
`;

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const pool = getPool();
    await pool.query(SQL);

    // Sanity check
    const r = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM ai_operations) AS ai_ops_count,
        (SELECT COUNT(*) FROM ai_summaries)  AS ai_sum_count,
        (SELECT COUNT(*) FROM notifications) AS notif_count
    `);

    return res.status(200).json({
      success: true,
      message: "ai_operations + ai_summaries + notifications tables ready",
      counts: r.rows[0],
    });
  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
