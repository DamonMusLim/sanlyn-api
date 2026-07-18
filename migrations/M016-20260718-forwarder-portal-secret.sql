-- P0 根治：货代门户凭证与标识分离(2026-07-18)
-- 病:forwarder_portal_tokens.code 是低熵可猜 slug(nbcosco/wanhui),数据端点直接拿URL slug鉴权→冒充泄露。
-- 修:加高熵 secret 列作唯一凭证(只进 fwd_session HttpOnly cookie),slug 降级为纯URL标签。
-- ⚠️现有2行的 secret 由 Node crypto.randomBytes(24)=48hex 填充(见部署记录);此默认值仅为未来手动insert兜底。
ALTER TABLE forwarder_portal_tokens ADD COLUMN IF NOT EXISTS secret text;
ALTER TABLE forwarder_portal_tokens ALTER COLUMN secret
  SET DEFAULT (md5(random()::text||clock_timestamp()::text)||md5(random()::text||clock_timestamp()::text));
CREATE UNIQUE INDEX IF NOT EXISTS idx_fpt_secret ON forwarder_portal_tokens(secret);
