-- M022-20260710-staff-scorecards-and-events.sql
-- 员工绩效档案层：评分卡(staff_scorecards) + 事件时间线(staff_events)。
-- 复用现有 staff_daily_reports(工作总结/日记) 的 staff_name 身份约定，不改动它。
-- 附加式、幂等(IF NOT EXISTS)、向后兼容。真源=本库(sanlyn_db)。
-- 数字只存快照+真源指针(source_ref)，有争议回原系统重算，防漂移。

CREATE TABLE IF NOT EXISTS staff_scorecards (
  id            bigserial PRIMARY KEY,
  staff_name    text        NOT NULL,
  store_name    text,
  period_kind   text        NOT NULL DEFAULT 'daily',   -- daily / weekly / monthly / adhoc
  period_date   date        NOT NULL DEFAULT CURRENT_DATE,
  period_start  date,
  period_end    date,
  score         numeric(4,2),                           -- 综合分 0-10
  breakdown     jsonb,                                  -- 各维度分 {"真实性":9,"手速":9,"日产出":5,"节奏":4}
  summary       text,                                   -- 主观点评正文(人话)
  metrics       jsonb,                                  -- 数字快照 {"submitted":165,"assigned":1207,...}
  source_system text,                                   -- 来源系统 e.g. 'clerk-check-card'
  source_ref    jsonb,                                  -- 真源指针 {"endpoint":..,"token":..,"date":..,"rule":"snapshot only"}
  scored_by     text        NOT NULL DEFAULT 'damon',   -- 打分人 damon / AI店长
  visibility    text        NOT NULL DEFAULT 'owner_only',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scorecard_staff ON staff_scorecards(staff_name);
CREATE INDEX IF NOT EXISTS idx_scorecard_date  ON staff_scorecards(period_date DESC);

CREATE TABLE IF NOT EXISTS staff_events (
  id            bigserial PRIMARY KEY,
  staff_name    text        NOT NULL,
  store_name    text,
  event_date    date        NOT NULL DEFAULT CURRENT_DATE,
  event_type    text        NOT NULL,                   -- praise / warning / incident / milestone / note
  title         text        NOT NULL,
  detail        text,
  severity      text                 DEFAULT 'info',    -- info / good / concern / serious
  source_system text,
  source_ref    jsonb,
  created_by    text        NOT NULL DEFAULT 'damon',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_staff ON staff_events(staff_name);
CREATE INDEX IF NOT EXISTS idx_event_date  ON staff_events(event_date DESC);
