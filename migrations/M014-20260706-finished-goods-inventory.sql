-- migration: M014-20260706-finished-goods-inventory
-- date: 2026-07-06
-- purpose: 建外贸出口成品库存流水与结存缓存表；库存独立于 products 主表（工厂供货入库→出口发货出库口径）
-- dependencies: products(id,is_canonical), companies(code)
-- 多仓: warehouses 表(seed 主仓 id=1); warehouse_id FK→warehouses(id) 默认主仓。库存按(sku,warehouse_id)分仓结存。
-- 单位: inventory_logs/finished_goods_inventory 带 unit(kg/个,自 products)。
-- 交货日期: inventory_logs.delivery_date 单独列(业务日期),与系统 at/created_at 分开。
-- author: codex(gpt-5.5) 起草 → Claude 审+装配(修 warehouse_id 幂等/rebuild保留safety_stock; 加多仓/unit/delivery_date)
-- ⚠️ apply 前检查：companies.code 必须有 UNIQUE 约束，否则 factory_code 外键会报错；若无则删除该 FK，factory_code 保留纯 TEXT。
-- 说明：本文件只建结构+函数+视图+索引；order_line_items 出库聚合(依赖发货表真列名)另做 M015。

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'inventory_log_type'
      AND n.nspname = current_schema()
  ) THEN
    CREATE TYPE inventory_log_type AS ENUM ('in', 'out', 'adjust');
  END IF;
END
$$;

-- 仓库维度（多仓）。warehouse_id=1 为默认主仓（下方 seed）。
CREATE TABLE IF NOT EXISTS warehouses (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- seed 主仓，固定 id=1（作为 inventory 表 warehouse_id 默认值）
INSERT INTO warehouses (id, code, name)
VALUES (1, 'MAIN', '主仓')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS inventory_logs (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id),
  sku TEXT NOT NULL,
  type inventory_log_type NOT NULL,
  quantity NUMERIC(14,3) NOT NULL,
  unit TEXT,  -- 该 SKU 本位单位(kg/个),denormalized 自 products;quantity 即以此单位计
  before_stock NUMERIC(14,3),
  after_stock NUMERIC(14,3),
  ref_type TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  warehouse_id BIGINT NOT NULL DEFAULT 1 REFERENCES warehouses(id),
  factory_code TEXT REFERENCES companies(code),
  delivery_date DATE,  -- 交货日期(业务日期,单独于系统 at/created_at);出库流水以此为准
  note TEXT,
  "operator" TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inventory_logs_quantity_nonzero_chk CHECK (quantity <> 0),
  CONSTRAINT inventory_logs_type_quantity_sign_chk CHECK (
    (type = 'in' AND quantity > 0)
    OR (type = 'out' AND quantity < 0)
    OR (type = 'adjust')
  ),
  CONSTRAINT inventory_logs_ref_sku_warehouse_uk UNIQUE (ref_type, ref_id, sku, warehouse_id)
);

CREATE TABLE IF NOT EXISTS finished_goods_inventory (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id),
  sku TEXT NOT NULL,
  unit TEXT,  -- 该 SKU 本位单位(kg/个),denormalized 自 products
  current_stock NUMERIC(14,3) NOT NULL DEFAULT 0,
  safety_stock NUMERIC(14,3) NOT NULL DEFAULT 0,
  factory_code TEXT REFERENCES companies(code),
  warehouse_id BIGINT NOT NULL DEFAULT 1 REFERENCES warehouses(id),
  last_move_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT finished_goods_inventory_sku_warehouse_uk UNIQUE (sku, warehouse_id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_logs_sku_at
  ON inventory_logs (sku, at DESC);

CREATE INDEX IF NOT EXISTS idx_inventory_logs_product_id_at
  ON inventory_logs (product_id, at DESC);

CREATE INDEX IF NOT EXISTS idx_inventory_logs_type_at
  ON inventory_logs (type, at DESC);

CREATE INDEX IF NOT EXISTS idx_inventory_logs_ref_type_ref_id
  ON inventory_logs (ref_type, ref_id);

CREATE INDEX IF NOT EXISTS idx_inventory_logs_delivery_date
  ON inventory_logs (delivery_date);

CREATE INDEX IF NOT EXISTS idx_finished_goods_inventory_product_id
  ON finished_goods_inventory (product_id);

CREATE INDEX IF NOT EXISTS idx_finished_goods_inventory_factory_code
  ON finished_goods_inventory (factory_code);

CREATE INDEX IF NOT EXISTS idx_finished_goods_inventory_below_safety
  ON finished_goods_inventory (sku, warehouse_id)
  WHERE current_stock <= safety_stock;

CREATE OR REPLACE FUNCTION rebuild_finished_goods_inventory()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  WITH stock_sum AS (
    SELECT
      il.sku,
      il.warehouse_id,
      SUM(il.quantity)::NUMERIC(14,3) AS current_stock,
      MAX(il.at) AS last_move_at
    FROM inventory_logs il
    GROUP BY il.sku, il.warehouse_id
  ),
  latest_log AS (
    SELECT DISTINCT ON (il.sku, il.warehouse_id)
      il.sku,
      il.warehouse_id,
      il.product_id,
      il.factory_code,
      il.unit
    FROM inventory_logs il
    ORDER BY il.sku, il.warehouse_id, il.at DESC, il.id DESC
  )
  INSERT INTO finished_goods_inventory (
    product_id,
    sku,
    unit,
    current_stock,
    factory_code,
    warehouse_id,
    last_move_at,
    created_at,
    updated_at
  )
  SELECT
    ll.product_id,
    ss.sku,
    ll.unit,
    ss.current_stock,
    ll.factory_code,
    ss.warehouse_id,
    ss.last_move_at,
    now(),
    now()
  FROM stock_sum ss
  JOIN latest_log ll
    ON ll.sku = ss.sku
   AND ll.warehouse_id = ss.warehouse_id
  ON CONFLICT (sku, warehouse_id) DO UPDATE
  SET
    product_id = EXCLUDED.product_id,
    unit = EXCLUDED.unit,
    current_stock = EXCLUDED.current_stock,
    factory_code = EXCLUDED.factory_code,
    last_move_at = EXCLUDED.last_move_at,
    updated_at = now();
END
$$;

CREATE OR REPLACE VIEW finished_goods_inventory_reconciliation AS
WITH log_stock AS (
  SELECT
    sku,
    warehouse_id,
    SUM(quantity)::NUMERIC(14,3) AS log_stock
  FROM inventory_logs
  GROUP BY sku, warehouse_id
)
SELECT
  fgi.id,
  fgi.product_id,
  fgi.sku,
  fgi.warehouse_id,
  fgi.factory_code,
  fgi.current_stock,
  COALESCE(ls.log_stock, 0)::NUMERIC(14,3) AS log_stock,
  (fgi.current_stock - COALESCE(ls.log_stock, 0))::NUMERIC(14,3) AS diff,
  CASE
    WHEN fgi.current_stock <> COALESCE(ls.log_stock, 0)::NUMERIC(14,3)
      THEN 'mismatch'
    ELSE 'matched'
  END AS status,
  fgi.last_move_at,
  fgi.updated_at
FROM finished_goods_inventory fgi
LEFT JOIN log_stock ls
  ON ls.sku = fgi.sku
 AND ls.warehouse_id = fgi.warehouse_id;
