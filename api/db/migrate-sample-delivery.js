// migrate-sample-delivery.js
// 样品交付协同表 + 任务核心表（4张）
//
// POST /api/db/migrate-sample-delivery
//   → 幂等建表，可安全重跑
//
// 建表顺序：
//   1. sample_delivery_sheets  — 样品交付主表（厂长确认 magic link 目标）
//   2. tasks                   — 任务中心主表（5节点工作流）
//   3. task_events             — 任务事件流
//   4. notifications_log       — 通知发送记录（不影响现有 notifications 命名）
// ─────────────────────────────────────────────────────────────────────────────
import { getPool, setCors } from "../db.js";

const SQL = `

-- ══════════════════════════════════════════════════════════════
-- 1. sample_delivery_sheets  — 样品交付协同表
--    linked via driver_assignments.collab_sheet_table = 'sample_delivery_sheets'
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS sample_delivery_sheets (
  id              SERIAL PRIMARY KEY,
  order_id        INTEGER,
  order_no        TEXT,
  contract_no     TEXT,
  customer_code   TEXT,                       -- 脱敏展示给厂长
  owner_company_code TEXT,

  -- 5 节点状态机
  status          TEXT NOT NULL DEFAULT 'draft',
  -- draft → awaiting_factory → factory_confirmed → qc_pending
  -- qc_passed → shipped → customer_signed → cancelled

  -- 节点 1：客户需求（Damon 建单时填）
  sample_brief    JSONB DEFAULT '{}'::jsonb,
  -- { product_name, spec, qty, purpose, target_price, deadline }

  -- 节点 2：厂长确认
  factory_confirmed_at  TIMESTAMPTZ,
  factory_note          TEXT,
  factory_capacity_ok   BOOLEAN,
  factory_schedule_date DATE,                 -- 厂长填排期
  factory_evidence_url  TEXT,                 -- 厂长上传排产单/样品照

  -- 节点 3：QC 验货
  qc_check_id     INTEGER,                    -- 关联 qc_checks.id（已有表）
  qc_passed_at    TIMESTAMPTZ,
  qc_note         TEXT,

  -- 节点 4：出货
  shipping_plan_id INTEGER,                   -- 关联 shipping_plans.id（已有表）
  shipped_at       TIMESTAMPTZ,
  tracking_no      TEXT,
  courier          TEXT,

  -- 节点 5：客户签收
  customer_signed_at   TIMESTAMPTZ,
  customer_feedback    TEXT,
  customer_rating      INTEGER,               -- 1-5

  -- 协同备注
  participant_note     TEXT,                  -- 厂长填写的备注
  admin_note           TEXT,                  -- Damon 内部备注（不展示给厂长）
  visible_note         TEXT,                  -- 给厂长看的说明

  -- 截止日期
  due_at          TIMESTAMPTZ,
  submitted_at    TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sample_delivery_order   ON sample_delivery_sheets(order_id);
CREATE INDEX IF NOT EXISTS idx_sample_delivery_status  ON sample_delivery_sheets(status);

-- ══════════════════════════════════════════════════════════════
-- 2. sample_workflow_tasks  — 样品交付节点任务表
--    独立于旧版 tasks 表，避免 schema 冲突
-- ══════════════════════════════════════════════════════════════
CREATE SEQUENCE IF NOT EXISTS swt_seq START 1;

CREATE TABLE IF NOT EXISTS sample_workflow_tasks (
  task_id         TEXT PRIMARY KEY DEFAULT (
    'SWT-' || to_char(NOW(), 'YYYY') || '-' || lpad(nextval('swt_seq')::text, 4, '0')
  ),
  title           TEXT NOT NULL,
  description     TEXT,

  -- 关联的样品交付工作流
  sample_sheet_id INTEGER REFERENCES sample_delivery_sheets(id),
  workflow_node   TEXT,
  -- CUSTOMER_REQUEST / FACTORY_CONFIRM / QC / SHIPMENT / CUSTOMER_SIGN

  -- 优先级
  risk_level      TEXT NOT NULL DEFAULT 'P3',  -- P0 / P1 / P2 / P3

  -- 状态机
  status          TEXT NOT NULL DEFAULT 'NEW',
  -- NEW / IN_PROGRESS / DONE / CANCELLED

  -- 归属
  owner_type      TEXT DEFAULT 'HUMAN',        -- HUMAN / AI / CRON
  owner_id        TEXT,

  -- 时间
  due_at          TIMESTAMPTZ,
  created_by      TEXT NOT NULL DEFAULT 'system',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,

  evidence_url    TEXT
);

CREATE INDEX IF NOT EXISTS idx_swt_status    ON sample_workflow_tasks(status);
CREATE INDEX IF NOT EXISTS idx_swt_sheet     ON sample_workflow_tasks(sample_sheet_id);

-- ══════════════════════════════════════════════════════════════
-- 3. sample_task_events  — 样品任务事件流
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS sample_task_events (
  event_id     TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  task_id      TEXT NOT NULL REFERENCES sample_workflow_tasks(task_id) ON DELETE CASCADE,

  event_type   TEXT NOT NULL,
  -- STATUS_CHANGE / NOTE / APPROVAL / REJECTION / ASSIGNMENT
  -- EVIDENCE_ADDED / AI_UPDATE / FACTORY_CONFIRM / QC_RESULT

  from_status  TEXT,
  to_status    TEXT,
  actor_type   TEXT DEFAULT 'SYSTEM',     -- HUMAN / AI / CRON / SYSTEM
  actor_id     TEXT,
  note         TEXT,
  evidence_url TEXT,
  payload      JSONB DEFAULT '{}'::jsonb,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ste_task ON sample_task_events(task_id);
CREATE INDEX IF NOT EXISTS idx_ste_time ON sample_task_events(created_at DESC);

-- ══════════════════════════════════════════════════════════════
-- 4. notifications_log  — 企微通知发送记录
--    (用 notifications_log 避免与已有命名冲突)
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS notifications_log (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  channel         TEXT NOT NULL DEFAULT 'WECOM_GROUP_BOT',
  -- WECOM_GROUP_BOT / WECOM_APP_MESSAGE / EMAIL / SYSTEM_ONLY

  message_type    TEXT NOT NULL,
  -- DAILY_DIARY_REMINDER / STAFF_REPORT_REMINDER / DAILY_SUMMARY
  -- FACTORY_CONFIRM_REQUEST / SAMPLE_SHIPPED / TASK_DONE / P0_ALERT

  target          TEXT,                   -- group_id / user_id
  message_summary TEXT,                   -- 脱敏摘要

  related_task_id         TEXT,
  related_sample_sheet_id INTEGER,

  sent_status     TEXT DEFAULT 'pending', -- pending / sent / failed / skipped_dedupe
  retry_count     INTEGER DEFAULT 0,
  sent_at         TIMESTAMPTZ,
  error_message   TEXT,

  dedupe_key      TEXT UNIQUE,            -- channel:type:target:YYYY-MM-DD
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notif_log_status ON notifications_log(sent_status);
CREATE INDEX IF NOT EXISTS idx_notif_log_dedupe ON notifications_log(dedupe_key);
`;

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const pool = getPool();
  try {
    await pool.query(SQL);
    return res.status(200).json({
      ok: true,
      message: "sample_delivery_sheets + sample_workflow_tasks + sample_task_events + notifications_log created (idempotent)",
      tables: ["sample_delivery_sheets", "sample_workflow_tasks", "sample_task_events", "notifications_log"],
    });
  } catch (err) {
    console.error("[migrate-sample-delivery] error:", err);
    return res.status(500).json({ error: err.message });
  }
}
