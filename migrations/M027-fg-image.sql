-- M027: 库存比对表 工厂可上传产品图(存fg,不覆盖产品主档)
ALTER TABLE finished_goods_inventory ADD COLUMN IF NOT EXISTS image_url TEXT;
