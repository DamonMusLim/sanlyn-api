-- M010: 补 tare_kg / vgm_kg（对齐 container-intake skill SSOT）
-- M009 误用 tare_weight_kg，这里补正确字段名，幂等

ALTER TABLE container_bookings
  ADD COLUMN IF NOT EXISTS tare_kg  NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS vgm_kg   NUMERIC(8,2);

COMMENT ON COLUMN container_bookings.tare_kg IS '箱皮重kg，柜门照片OCR读取，禁用假定值';
COMMENT ON COLUMN container_bookings.vgm_kg  IS 'VGM=cargo_weight_kg+tare_kg，SOLAS申报值';
