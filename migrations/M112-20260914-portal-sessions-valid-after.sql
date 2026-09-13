-- M112 2026-09-14 portal token 登出吊销(MED ⑥)
-- token 签发时间(ts)早于此列则失效;登出/改密时设为 now()。
-- 幂等;已在生产(/opt/sanlyn-api-test)手工执行并 e2e 验证通过。
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS sessions_valid_after timestamptz;
