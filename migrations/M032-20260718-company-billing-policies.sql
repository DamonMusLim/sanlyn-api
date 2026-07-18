-- M032 2026-07-18 company billing policies + port-charge standard snapshot
-- Scope: schema only. Do not seed policies here; 0 rows keeps current markup behavior.

CREATE TABLE IF NOT EXISTS company_billing_policies (
  id                     bigserial PRIMARY KEY,
  company_code            text NOT NULL REFERENCES companies(code),
  fee_domain              text NOT NULL CHECK (fee_domain IN ('port_charge','ocean_freight','trucking','customs','insurance')),
  billing_mode            text NOT NULL CHECK (billing_mode IN ('pass_through','markup')),
  effective_from          date NOT NULL DEFAULT CURRENT_DATE,
  effective_to            date,
  requires_official_rate  boolean NOT NULL DEFAULT false,
  notes                  text,
  created_by              text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  UNIQUE (company_code, fee_domain, effective_from)
);

CREATE INDEX IF NOT EXISTS idx_company_billing_policies_lookup
  ON company_billing_policies (company_code, fee_domain, effective_from DESC);

ALTER TABLE shipping_plans
  ADD COLUMN IF NOT EXISTS port_charge_pricing_mode text,
  ADD COLUMN IF NOT EXISTS port_charge_standard_version text,
  ADD COLUMN IF NOT EXISTS port_charge_standard_snapshot jsonb;

COMMENT ON TABLE company_billing_policies IS
  'Per-company billing policy by fee domain. Empty table means existing markup behavior remains unchanged.';

COMMENT ON COLUMN shipping_plans.port_charge_standard_snapshot IS
  'Frozen official carrier port-charge pricing snapshot used for pass-through statements.';
