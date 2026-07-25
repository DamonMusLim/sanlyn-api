-- M038 (2026-07-25) product_insurance_pref — 产品级投保偏好(记住某产品+客户上次的承保方/范围/加成)。
-- 幂等。红线:本表绝不存 rate/cost/premium 等成本或费率字段;markup_pct=对外投保比例(保额=发票×110%),非成本。
BEGIN;

CREATE TABLE IF NOT EXISTS product_insurance_pref (
  id BIGSERIAL PRIMARY KEY,
  product_key         TEXT NOT NULL,
  customer_id         TEXT NOT NULL,
  last_insurer        TEXT NOT NULL DEFAULT '人保',
  last_cover          TEXT NOT NULL DEFAULT 'ICC-A',
  last_markup_pct     NUMERIC(6,2) NOT NULL DEFAULT 110,
  last_special_cargo  TEXT,
  updated_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT product_insurance_pref_uk UNIQUE (product_key, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_product_insurance_pref_customer
  ON product_insurance_pref (customer_id);

COMMIT;
