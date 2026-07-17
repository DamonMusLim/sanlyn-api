-- M023: SKU库存对账表 新增工厂可填字段(柜容量/供应商名). safety_stock 列已存在.
ALTER TABLE finished_goods_inventory ADD COLUMN IF NOT EXISTS container_capacity NUMERIC(14,3);
ALTER TABLE finished_goods_inventory ADD COLUMN IF NOT EXISTS supplier_name TEXT;
