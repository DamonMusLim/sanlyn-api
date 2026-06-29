-- M009: 内转外字段 — container_bookings加皮重，shipping_plans加内贸BL
-- 幂等: ADD COLUMN IF NOT EXISTS

ALTER TABLE container_bookings
  ADD COLUMN IF NOT EXISTS tare_weight_kg NUMERIC(8,2);  -- 柜皮重(kg), 20GP约2200

ALTER TABLE shipping_plans
  ADD COLUMN IF NOT EXISTS inland_bl TEXT;  -- 内贸提单号(快到港才填)

COMMENT ON COLUMN container_bookings.tare_weight_kg IS '柜皮重kg，来自柱照片OCR或车队报告，20GP默认2200';
COMMENT ON COLUMN shipping_plans.inland_bl IS '内贸船提单号，用于内转外表格，一般快到港才有';
