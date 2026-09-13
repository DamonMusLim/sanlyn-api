-- M113-20260913-freight-rates-reefer.sql
-- 运价表加冷冻柜(reefer)：沿用既有 gp20/hq40 + customer_* 命名惯例。
-- 20RF = 20' 冷冻柜, 40RH = 40' 高箱冷冻柜(行业标准码)。
-- 冷冻(-18℃) 与 冷藏(0~4℃) 是同一种箱、不同温区 → 用 reefer_temp_c 区分，不另设箱型。
-- 全部可空、可加，不改任何现有列，不回填。
ALTER TABLE freight_rates
  ADD COLUMN IF NOT EXISTS rf20           numeric,
  ADD COLUMN IF NOT EXISTS rh40           numeric,
  ADD COLUMN IF NOT EXISTS customer_rf20  numeric,
  ADD COLUMN IF NOT EXISTS customer_rh40  numeric,
  ADD COLUMN IF NOT EXISTS reefer_temp_c  numeric;

COMMENT ON COLUMN freight_rates.rf20          IS '20RF 冷冻柜成本价';
COMMENT ON COLUMN freight_rates.rh40          IS '40RH 冷冻高箱成本价';
COMMENT ON COLUMN freight_rates.customer_rf20 IS '20RF 冷冻柜客户价';
COMMENT ON COLUMN freight_rates.customer_rh40 IS '40RH 冷冻高箱客户价';
COMMENT ON COLUMN freight_rates.reefer_temp_c IS '冷冻柜设定温度(摄氏度)，冷冻约 -18，冷藏约 0~4';
