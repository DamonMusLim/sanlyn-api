-- M033 2026-07-18 freight rate contract / guaranteed-space fields
-- Scope: nullable columns only. Existing freight_rates rows keep rate_type NULL.

ALTER TABLE freight_rates
  ADD COLUMN IF NOT EXISTS rate_type text
    CHECK (rate_type IS NULL OR rate_type IN ('spot','quote','contract')),
  ADD COLUMN IF NOT EXISTS price_tier text
    CHECK (price_tier IS NULL OR price_tier IN ('standard','guaranteed_space')),
  ADD COLUMN IF NOT EXISTS contract_no text,
  ADD COLUMN IF NOT EXISTS carrier_contract_id text,
  ADD COLUMN IF NOT EXISTS committed_teu numeric(12,2),
  ADD COLUMN IF NOT EXISTS used_teu numeric(12,2),
  ADD COLUMN IF NOT EXISTS guarantee_status text,
  ADD COLUMN IF NOT EXISTS space_commitment text,
  ADD COLUMN IF NOT EXISTS free_pol_days integer,
  ADD COLUMN IF NOT EXISTS free_pod_days integer,
  ADD COLUMN IF NOT EXISTS schedule_commitment text;

CREATE INDEX IF NOT EXISTS idx_freight_rates_contract_no
  ON freight_rates (contract_no)
  WHERE contract_no IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_freight_rates_rate_type
  ON freight_rates (rate_type, price_tier)
  WHERE rate_type IS NOT NULL;
