-- ══════════════════════════════════════════════════════════════════════════════
-- Rollback 026: 撤销 shipping schema 约束
-- 安全: 全部幂等 (IF EXISTS)，只删约束/索引，不删数据
-- 前置条件: migration 026 已跑
-- Date: 2026-05-23
-- ══════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP R1: 删除 CHECK 约束
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE freight_rates DROP CONSTRAINT IF EXISTS chk_freight_doc_cutoff;
ALTER TABLE freight_rates DROP CONSTRAINT IF EXISTS chk_freight_cargo_cutoff;
ALTER TABLE freight_rates DROP CONSTRAINT IF EXISTS chk_freight_currency;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP R2: 删除 FK 约束（先删 FK 才能删 UNIQUE/PK）
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE orders DROP CONSTRAINT IF EXISTS fk_orders_shipping_plan;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS fk_orders_freight_rate;
ALTER TABLE shipping_plans DROP CONSTRAINT IF EXISTS fk_shipping_plans_local_charges;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP R3: 删除索引
-- ─────────────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS idx_orders_shipping_plan_id;
DROP INDEX IF EXISTS idx_orders_freight_rate_id;
DROP INDEX IF EXISTS idx_shipping_plans_local_charges_code;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP R4: 删除 UNIQUE 约束（在 local_charges.charge_code 上）
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE local_charges DROP CONSTRAINT IF EXISTS uq_local_charges_code;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP R5: 删除 PRIMARY KEY（如确实要回滚，极少数情况）
-- 注意: 删 PK 可能影响其他依赖。如不确定，跳过此步
-- ─────────────────────────────────────────────────────────────────────────────
-- ALTER TABLE freight_rates DROP CONSTRAINT IF EXISTS freight_rates_pkey;
-- ALTER TABLE shipping_plans DROP CONSTRAINT IF EXISTS shipping_plans_pkey;

-- ─────────────────────────────────────────────────────────────────────────────
-- 验证: 跑完后确认约束已消失
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT constraint_name, constraint_type, table_name
-- FROM information_schema.table_constraints
-- WHERE constraint_name IN (
--   'fk_orders_shipping_plan','fk_orders_freight_rate','fk_shipping_plans_local_charges',
--   'uq_local_charges_code','chk_freight_doc_cutoff','chk_freight_cargo_cutoff','chk_freight_currency'
-- );
-- -- 期望: 0 行
