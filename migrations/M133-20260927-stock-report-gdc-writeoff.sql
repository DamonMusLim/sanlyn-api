-- M133: 店员「确认丢失」自动推果冻橙报损(Damon 0927 批准)。推送脚本 mini ~/bin/push_writeoff.py --auto-loss
-- gdc_writeoff_at 非空 = 已处理过(成功或失败都算),⛔不重推;失败看 gdc_writeoff_result 人工处理。

ALTER TABLE petstore_stock_reports ADD COLUMN IF NOT EXISTS gdc_writeoff_order_no TEXT;
ALTER TABLE petstore_stock_reports ADD COLUMN IF NOT EXISTS gdc_writeoff_at TIMESTAMPTZ;
ALTER TABLE petstore_stock_reports ADD COLUMN IF NOT EXISTS gdc_writeoff_result TEXT;
