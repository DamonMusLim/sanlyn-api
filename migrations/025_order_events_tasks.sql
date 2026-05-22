-- ══════════════════════════════════════════════════════════════════════
-- Migration 025: order_events + order_tasks
-- Implements v3.2 §6.1 (event log) and §6.2 (task assignments)
-- Date: 2026-05-23
-- Safe: all CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS
-- No DROP / no destructive ops
-- ══════════════════════════════════════════════════════════════════════

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  PART 1: order_events — 不可变事件日志 (v3.2 §6.1)              ║
-- ╚══════════════════════════════════════════════════════════════════╝

-- 每行 = 一个订单状态变更事件 (里程碑) 或一次多轮协商记录 (negotiation)
-- 里程碑事件: is_current=TRUE + event_group <> 'negotiation' → 唯一 (order_id, stage_key)
-- 协商轮次:   event_group='negotiation' → 同 stage_key 可多行 (含 sequence_no)
CREATE TABLE IF NOT EXISTS order_events (
  id               BIGSERIAL        PRIMARY KEY,
  order_id         INT              NOT NULL,             -- FK → orders.id (无显式 FK 避免旧数据破坏)
  stage_key        VARCHAR(48)      NOT NULL,             -- 37 state_keys from v3.2 §3
  event_group      VARCHAR(32),                          -- 'milestone' | 'negotiation' | 'exception' | NULL
  sequence_no      INT              DEFAULT 1,           -- negotiation 轮次号, milestone 固定 1
  is_current       BOOLEAN          DEFAULT TRUE,         -- 最新有效事件标记
  occurred_at      TIMESTAMPTZ      NOT NULL,             -- 事件实际发生时间 (可回填过去时间)
  actor_role       VARCHAR(32),                          -- 9 roles from v3.2 §7
  actor_company_id VARCHAR(64),                          -- company_code 如 CN-00037
  actor_user_id    VARCHAR(64),                          -- email or system id
  source           VARCHAR(24),                          -- 'manual'|'api'|'ocr'|'system'|'import'
  visibility_scope JSONB,                                -- 哪些 role 可见, NULL = all roles
  confidence       NUMERIC(4,3),                         -- OCR/AI 置信度 0.000–1.000
  status           VARCHAR(16)      DEFAULT 'active',    -- 'active'|'superseded'|'voided'
  meta             JSONB,                                -- 扩展字段 (BL号/vessel/费用快照等)
  created_at       TIMESTAMPTZ      DEFAULT NOW()
);

-- 里程碑唯一性: 同一订单同一 stage_key 只能有一条 is_current=TRUE 的 active 事件
-- negotiation 轮次不受此约束 (event_group='negotiation' 排除)
CREATE UNIQUE INDEX IF NOT EXISTS uq_current_milestone_event
  ON order_events (order_id, stage_key)
  WHERE status = 'active'
    AND is_current = TRUE
    AND event_group IS DISTINCT FROM 'negotiation';

-- 查询加速
CREATE INDEX IF NOT EXISTS idx_order_events_order_id      ON order_events (order_id);
CREATE INDEX IF NOT EXISTS idx_order_events_stage_key     ON order_events (stage_key);
CREATE INDEX IF NOT EXISTS idx_order_events_occurred_at   ON order_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_events_actor_company ON order_events (actor_company_id);

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  PART 2: order_tasks — 任务指派 (v3.2 §6.2)                     ║
-- ╚══════════════════════════════════════════════════════════════════╝

-- 每行 = 一个待办任务 (可多人 / 多轮)
-- 5 状态生命周期: open → in_progress → done | cancelled | blocked
CREATE TABLE IF NOT EXISTS order_tasks (
  id               BIGSERIAL        PRIMARY KEY,
  order_id         INT              NOT NULL,
  task_type        VARCHAR(48)      NOT NULL,             -- 任务类型 key (见 v3.2 §6.2 枚举)
  title            TEXT             NOT NULL,             -- 简短标题 (界面显示)
  description      TEXT,                                  -- 详细说明 (可选)
  assigned_role    VARCHAR(32),                          -- 接收方角色 (同 9 roles)
  assigned_company VARCHAR(64),                          -- 接收方 company_code
  assigned_user    VARCHAR(64),                          -- 接收方 email (精确指派)
  status           VARCHAR(16)      DEFAULT 'open',       -- open|in_progress|done|cancelled|blocked
  priority         VARCHAR(8)       DEFAULT 'normal',    -- low|normal|high|urgent
  due_at           TIMESTAMPTZ,                          -- 截止时间
  created_by_role  VARCHAR(32),
  created_by_user  VARCHAR(64),
  resolved_at      TIMESTAMPTZ,
  resolved_by      VARCHAR(64),
  resolution_note  TEXT,
  meta             JSONB,                                -- 扩展 (文件URL/金额/参考单号等)
  created_at       TIMESTAMPTZ      DEFAULT NOW(),
  updated_at       TIMESTAMPTZ      DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_tasks_order_id    ON order_tasks (order_id);
CREATE INDEX IF NOT EXISTS idx_order_tasks_status      ON order_tasks (status) WHERE status NOT IN ('done','cancelled');
CREATE INDEX IF NOT EXISTS idx_order_tasks_assigned    ON order_tasks (assigned_company, assigned_role);
CREATE INDEX IF NOT EXISTS idx_order_tasks_due_at      ON order_tasks (due_at) WHERE due_at IS NOT NULL;

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  PART 3: shipping schema (from audit 2026-05-22)                ║
-- ║  orders + freight_rates + shipping_plans 补字段                  ║
-- ╚══════════════════════════════════════════════════════════════════╝

-- orders 表绑定海运计划
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS shipping_plan_id INTEGER,
  ADD COLUMN IF NOT EXISTS freight_rate_id  INTEGER;

-- freight_rates 补充字段
ALTER TABLE freight_rates
  ADD COLUMN IF NOT EXISTS currency      VARCHAR(10) DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS sail_date     DATE,
  ADD COLUMN IF NOT EXISTS doc_cutoff    DATE,
  ADD COLUMN IF NOT EXISTS cargo_cutoff  DATE;

-- shipping_plans 补充利润字段
ALTER TABLE shipping_plans
  ADD COLUMN IF NOT EXISTS ocean_freight_profit_usd NUMERIC,
  ADD COLUMN IF NOT EXISTS local_charges_code       TEXT;

-- 自动关联港杂费 (唯一匹配, 安全执行)
UPDATE freight_rates
  SET local_charge_code = 'GZ00011'
  WHERE pol  ILIKE '%tianjin%'
    AND pod  ILIKE '%kinabalu%'
    AND carrier ILIKE '%MSK%'
    AND local_charge_code IS NULL;

UPDATE freight_rates
  SET local_charge_code = 'GZ00013'
  WHERE pol  ILIKE '%qingdao%'
    AND pod  ILIKE '%klang%'
    AND carrier ILIKE '%OOCL%'
    AND local_charge_code IS NULL;

-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  验证查询 (跑完后手动对账)                                        ║
-- ╚══════════════════════════════════════════════════════════════════╝

-- SELECT 'order_events' AS tbl, COUNT(*) FROM order_events;
-- SELECT 'order_tasks'  AS tbl, COUNT(*) FROM order_tasks;
-- SELECT COUNT(*) as total, COUNT(local_charge_code) as lc_linked,
--        COUNT(gp20) + COUNT(hq40) as has_any_rate
-- FROM freight_rates;
