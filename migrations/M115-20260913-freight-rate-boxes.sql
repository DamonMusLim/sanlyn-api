-- M115-20260913-freight-rate-boxes.sql
-- 一条运价可以挂任意多个箱型的价。gp20/hq40/rf20/rh40 四对列【保持不动】，
-- 下游(建票选价/门户回写/marketplace/单据PDF)还在读它们，本表是【增量】不是替换。
-- 约定:20GP/40HQ/20RF/40RH 继续走原列，其余 57 种箱型走本表。
CREATE TABLE IF NOT EXISTS freight_rate_boxes (
  id              bigserial PRIMARY KEY,
  rate_id         integer NOT NULL REFERENCES freight_rates(id) ON DELETE CASCADE,
  container_type  text    NOT NULL REFERENCES container_types(code),
  cost            numeric,
  customer_price  numeric,
  remarks         text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rate_id, container_type)
);
CREATE INDEX IF NOT EXISTS idx_frb_rate ON freight_rate_boxes(rate_id);
COMMENT ON TABLE  freight_rate_boxes IS '运价的多箱型价格(除 20GP/40HQ/20RF/40RH 四种走 freight_rates 原列之外的箱型)';
COMMENT ON COLUMN freight_rate_boxes.cost           IS '该箱型成本价,币种跟随 freight_rates.currency';
COMMENT ON COLUMN freight_rate_boxes.customer_price IS '该箱型客户价,币种跟随 freight_rates.currency';
