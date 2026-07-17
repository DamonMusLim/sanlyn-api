ALTER TABLE shipping_plans
  ADD COLUMN IF NOT EXISTS contract_split_version smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS contract_base_no text,
  ADD COLUMN IF NOT EXISTS contract_split_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS shipping_plan_contract_splits (
  id bigserial PRIMARY KEY,
  shipping_plan_id bigint NOT NULL REFERENCES shipping_plans(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('freight_usd', 'goods_cny')),
  currency text NOT NULL CHECK (currency IN ('USD', 'CNY')),
  contract_no text NOT NULL,
  is_customs_contract boolean NOT NULL DEFAULT false,
  is_freight_contract boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'void')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shipping_plan_id, role),
  UNIQUE (contract_no)
);

CREATE INDEX IF NOT EXISTS idx_sp_contract_splits_plan ON shipping_plan_contract_splits(shipping_plan_id);
CREATE INDEX IF NOT EXISTS idx_sp_contract_splits_contract_no ON shipping_plan_contract_splits(contract_no);
