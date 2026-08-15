-- M075 · 失败红灯 + 移动审批留痕
-- 新建表，不改已应用 migration。审批快照只存当时用于判断的数据，不塞工资/成本等无关敏感字段。

CREATE TABLE IF NOT EXISTS job_failures (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  impact TEXT,
  error_name TEXT,
  error_message TEXT NOT NULL,
  error_stack TEXT,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'open',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_count INTEGER NOT NULL DEFAULT 1,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT,
  CONSTRAINT job_failures_status_chk CHECK (status IN ('open','acknowledged','resolved'))
);

CREATE INDEX IF NOT EXISTS idx_job_failures_open_last_seen
  ON job_failures(status, last_seen_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_job_failures_open_fingerprint
  ON job_failures(source, error_message)
  WHERE status='open';

ALTER TABLE hr_leave_requests
  ADD COLUMN IF NOT EXISTS approval_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS approval_actor_person_id BIGINT;

ALTER TABLE hr_reimbursements
  ADD COLUMN IF NOT EXISTS approval_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS approval_actor_person_id BIGINT;
