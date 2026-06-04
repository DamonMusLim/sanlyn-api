-- ══════════════════════════════════════════════════════════════════════════════
-- Rollback 025: 撤销 order_events / order_tasks + shipping schema ALTER
-- 警告: 此脚本会永久删除 order_events / order_tasks 表中的所有数据
-- 生产前必须确认已备份，且没有依赖这两张表的活跃业务
-- Date: 2026-05-23
-- ══════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP R1: 删除 order_tasks（先删，因可能有 FK 引用 order_events）
-- ─────────────────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS order_tasks;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP R2: 删除 order_events
-- ─────────────────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS order_events;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP R3: 撤销 orders 新增字段（数据已存在则会丢失，确认后跑）
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE orders DROP COLUMN IF EXISTS shipping_plan_id;
ALTER TABLE orders DROP COLUMN IF EXISTS freight_rate_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP R4: 撤销 freight_rates 新增字段
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE freight_rates DROP COLUMN IF EXISTS currency;
ALTER TABLE freight_rates DROP COLUMN IF EXISTS sail_date;
ALTER TABLE freight_rates DROP COLUMN IF EXISTS doc_cutoff;
ALTER TABLE freight_rates DROP COLUMN IF EXISTS cargo_cutoff;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP R5: 撤销 shipping_plans 新增字段
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE shipping_plans DROP COLUMN IF EXISTS ocean_freight_profit_usd;
ALTER TABLE shipping_plans DROP COLUMN IF EXISTS local_charges_code;

-- ─────────────────────────────────────────────────────────────────────────────
-- 验证: 跑完后确认这些列/表已消失
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name IN ('orders','freight_rates','shipping_plans')
--   AND column_name IN ('shipping_plan_id','freight_rate_id','currency',
--                        'sail_date','doc_cutoff','cargo_cutoff',
--                        'ocean_freight_profit_usd','local_charges_code');
-- -- 期望: 0 行

-- SELECT tablename FROM pg_tables
-- WHERE tablename IN ('order_events','order_tasks');
-- -- 期望: 0 行
