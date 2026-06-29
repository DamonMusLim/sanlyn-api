-- M009: 内转外字段 — container_bookings加皮重+VGM，shipping_plans加内贸BL
-- 幂等: ADD COLUMN IF NOT EXISTS
-- 字段名对齐 container-intake skill 的 SSOT: tare_kg / vgm_kg

ALTER TABLE container_bookings
  ADD COLUMN IF NOT EXISTS tare_kg   NUMERIC(8,2),  -- 箱皮重(kg), 从柜门照片OCR读取
  ADD COLUMN IF NOT EXISTS vgm_kg    NUMERIC(8,2);  -- VGM=cargo_weight_kg+tare_kg

ALTER TABLE shipping_plans
  ADD COLUMN IF NOT EXISTS inland_bl TEXT;  -- 内贸提单号，快到港才填

COMMENT ON COLUMN container_bookings.tare_kg  IS '箱皮重kg，柜门照片OCR，20GP约2100-2400，禁用假定值';
COMMENT ON COLUMN container_bookings.vgm_kg   IS 'VGM=cargo_weight_kg+tare_kg，SOLAS合规申报值';
COMMENT ON COLUMN shipping_plans.inland_bl    IS '内贸船提单号，用于内转外表格，快到港才有';
