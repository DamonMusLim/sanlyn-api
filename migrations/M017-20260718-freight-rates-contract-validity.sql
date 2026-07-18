-- 修复 freight-rates 500(2026-07-18):船司官方费率蓝图的 freight-rates.js 引用了
-- contract_valid_from/contract_valid_to 两列但从没建→整个端点崩(报价中心海运tab+运费页全死)。
-- 代码部署跑在 migration 前面的典型事故。补齐可空列(纯透传语义)。
ALTER TABLE freight_rates ADD COLUMN IF NOT EXISTS contract_valid_from date;
ALTER TABLE freight_rates ADD COLUMN IF NOT EXISTS contract_valid_to date;
