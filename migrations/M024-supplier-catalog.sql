-- M024: 供应链-供应商款式报价 字段与供应商表
-- packaging_materials(袋子款式档案) 加 供应商可填字段
ALTER TABLE packaging_materials ADD COLUMN IF NOT EXISTS material TEXT;                 -- 材质(Pa+PE等)
ALTER TABLE packaging_materials ADD COLUMN IF NOT EXISTS plate_fee NUMERIC(14,2);        -- 退版费
ALTER TABLE packaging_materials ADD COLUMN IF NOT EXISTS price_ex_tax NUMERIC(14,4);     -- 未含税单价(供应商填)
ALTER TABLE packaging_materials ADD COLUMN IF NOT EXISTS tax_point NUMERIC(6,2);         -- 开票点数%(供应商填); 含税价=未含税*(1+点数/100)
ALTER TABLE packaging_materials ADD COLUMN IF NOT EXISTS supplier_code TEXT;             -- 供应商码(作用域)
CREATE INDEX IF NOT EXISTS idx_pm_supplier_code ON packaging_materials(supplier_code);

-- 供应商开票信息表
CREATE TABLE IF NOT EXISTS suppliers (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  tax_no TEXT,
  bank_name TEXT,
  bank_account TEXT,
  bank_code TEXT,
  address TEXT,
  contact TEXT,
  phone TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
