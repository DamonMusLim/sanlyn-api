BEGIN;

ALTER TABLE petstore_takeout_picks
  ADD COLUMN IF NOT EXISTS gdc_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gdc_result TEXT;

COMMENT ON COLUMN petstore_takeout_picks.gdc_synced_at IS '果冻橙 pickedV2 同步成功时间';
COMMENT ON COLUMN petstore_takeout_picks.gdc_result IS '果冻橙 pickedV2 同步结果/错误摘要';

COMMIT;
