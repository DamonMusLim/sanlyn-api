-- M065: 结算单据日真源字段 so_date(下单日) + 存量回填 min(etd,录入日,今天)  2026-08-14 Damon定
ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS so_date date;
UPDATE shipping_plans SET so_date = LEAST(COALESCE(etd::date, created_at::date), created_at::date, CURRENT_DATE)
 WHERE so_date IS NULL;
