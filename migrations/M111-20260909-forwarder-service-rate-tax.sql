-- M111: forwarder portal service quotes are tax-included.
-- Existing quote rows keep nullable tax identity fields until the forwarder's invoice identity is confirmed.

ALTER TABLE forwarder_service_rates
  ADD COLUMN IF NOT EXISTS tax_included boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS tax_rate numeric,
  ADD COLUMN IF NOT EXISTS service_nature text,
  ADD COLUMN IF NOT EXISTS rate_cny_ex_tax numeric;
