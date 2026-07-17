-- M026: 供应商款式报价 v2 — 更多字段
ALTER TABLE packaging_materials ADD COLUMN IF NOT EXISTS brand TEXT;                        -- 品牌(筛选)
ALTER TABLE packaging_materials ADD COLUMN IF NOT EXISTS barcode TEXT;                       -- 产品条形码(防印错)
ALTER TABLE packaging_materials ADD COLUMN IF NOT EXISTS supplier_item_code TEXT;            -- 供应商内部货号
ALTER TABLE packaging_materials ADD COLUMN IF NOT EXISTS moq NUMERIC(14,2);                  -- 起订量
ALTER TABLE packaging_materials ADD COLUMN IF NOT EXISTS lead_time_days INTEGER;             -- 交期(天)
ALTER TABLE packaging_materials ADD COLUMN IF NOT EXISTS quote_date DATE;                    -- 报价日期
ALTER TABLE packaging_materials ADD COLUMN IF NOT EXISTS quote_valid_until DATE;             -- 报价有效期
ALTER TABLE packaging_materials ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';        -- 在产/停产
ALTER TABLE packaging_materials ADD COLUMN IF NOT EXISTS plate_fee_refund_qty NUMERIC(14,2);  -- 退版费退款累计量阈值
CREATE INDEX IF NOT EXISTS idx_pm_brand ON packaging_materials(brand);
