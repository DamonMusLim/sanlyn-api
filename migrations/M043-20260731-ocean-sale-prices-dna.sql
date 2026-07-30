-- M043 海运销售价拆件表 + DNA 习惯学习表 [Damon 0731]
-- 病根: 之前无销售价专表, freight_sale_usd 散字段, 无法按客户拆件定价/学习
-- 铁律: 成本只读锁定; DNA 只建议不自动填; 缺历史留空绝不拿成本当售价

-- 1) 拆件销售价表: 一票 × 一费用件 一行 (海运费/港杂费/拖车费/报关费/其他)
CREATE TABLE IF NOT EXISTS ocean_sale_prices (
  id                  BIGSERIAL PRIMARY KEY,
  bl_no               TEXT NOT NULL,
  shipping_plan_id    TEXT,
  customer_company_code TEXT,
  pol                 TEXT,
  pod                 TEXT,
  container_type      TEXT,
  fee_item            TEXT NOT NULL,          -- ocean|port_charge|trucking|customs|other
  cost_amount         NUMERIC(14,2),          -- 只读快照(来自bills/plans), 便于留痕对比
  cost_currency       TEXT,
  sale_amount         NUMERIC(14,2),          -- Damon 录/确认的售价 (可空=待定)
  sale_currency       TEXT,
  source              TEXT DEFAULT 'manual',  -- manual|dna_adopted (采用DNA建议留痕)
  effective_date      DATE,
  created_by          TEXT,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),
  UNIQUE (bl_no, fee_item)
);
CREATE INDEX IF NOT EXISTS idx_osp_customer ON ocean_sale_prices (customer_company_code, pol, pod, container_type, fee_item);
CREATE INDEX IF NOT EXISTS idx_osp_bl ON ocean_sale_prices (bl_no);

-- 2) DNA 习惯表: 按 客户+航线+柜型+费用件 聚合 Damon 的定价习惯 → 给建议
CREATE TABLE IF NOT EXISTS ocean_sale_price_dna (
  id                  BIGSERIAL PRIMARY KEY,
  customer_company_code TEXT NOT NULL,
  pol                 TEXT,
  pod                 TEXT,
  container_type      TEXT,
  fee_item            TEXT NOT NULL,
  suggested_sale      NUMERIC(14,2),          -- 建议售价(最近/中位历史成交)
  suggested_currency  TEXT,
  markup_ratio        NUMERIC(8,4),           -- 平均 售价/成本 (参考, 非强制)
  sample_count        INT DEFAULT 0,          -- 历史样本数 (0=无历史→UI显"待你定")
  last_sale_amount    NUMERIC(14,2),
  last_confirmed_at   TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ DEFAULT now(),
  UNIQUE (customer_company_code, pol, pod, container_type, fee_item)
);
