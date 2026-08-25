-- M101 2026-08-25 business alerts company fields
-- 待批准，未经 Damon 拍板不得执行。
-- 不含事务结束语句：runner 可外层 BEGIN/ROLLBACK 真空跑。

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS credit_limit numeric,
  ADD COLUMN IF NOT EXISTS credit_currency varchar(8),
  ADD COLUMN IF NOT EXISTS credit_limit_note text,
  ADD COLUMN IF NOT EXISTS contract_start date,
  ADD COLUMN IF NOT EXISTS contract_end date;
