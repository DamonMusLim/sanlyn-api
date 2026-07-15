-- 供应链协同 2026-07-15:库存提醒决策 + 工厂盘点 + 版费原图
-- 已 apply 腾讯 live(直接 ALTER,幂等)。此文件为 canonical 归档。
ALTER TABLE finished_goods_inventory ADD COLUMN IF NOT EXISTS restock_decision TEXT;
ALTER TABLE finished_goods_inventory ADD COLUMN IF NOT EXISTS restock_decision_by TEXT;
ALTER TABLE finished_goods_inventory ADD COLUMN IF NOT EXISTS restock_decision_at TIMESTAMPTZ;
ALTER TABLE finished_goods_inventory ADD COLUMN IF NOT EXISTS stocktook_at TIMESTAMPTZ;
ALTER TABLE packaging_materials ADD COLUMN IF NOT EXISTS plate_image_url TEXT;
