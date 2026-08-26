-- 待批准：创建预警忽略专用表；人工审核后再执行。

CREATE TABLE IF NOT EXISTS alert_ignores (
  id bigserial PRIMARY KEY,
  scope varchar NOT NULL,
  target_key text NOT NULL,
  actor varchar,
  created_at timestamptz NOT NULL DEFAULT now(),
  note text
);

CREATE UNIQUE INDEX IF NOT EXISTS alert_ignores_scope_target_key_uidx
  ON alert_ignores (scope, target_key);

CREATE INDEX IF NOT EXISTS alert_ignores_created_at_idx
  ON alert_ignores (created_at DESC);
