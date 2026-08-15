-- M076 2026-08-16 改价拍板留痕
-- 老板在 /m/pricing 拍板 petstore_price_intents 时,记下谁批的/什么时候/理由/当时的快照。
-- ⛔ 不要写 result 列 —— 那是执行器(run_pricing.py)回写执行结果用的,会覆盖。
ALTER TABLE petstore_price_intents
  ADD COLUMN IF NOT EXISTS decided_by_person_id BIGINT,
  ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decided_note TEXT,
  ADD COLUMN IF NOT EXISTS decided_snapshot JSONB;

CREATE INDEX IF NOT EXISTS ix_ppi_decided_at
  ON petstore_price_intents(decided_at)
  WHERE decided_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_ppi_decided_by_person_id
  ON petstore_price_intents(decided_by_person_id)
  WHERE decided_by_person_id IS NOT NULL;
