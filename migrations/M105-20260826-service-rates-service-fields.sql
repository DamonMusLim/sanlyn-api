-- M105: service_rates fields for truck/customs quote dimensions.
-- Nullable only. Existing rows are intentionally not backfilled.

ALTER TABLE service_rates
  ADD COLUMN IF NOT EXISTS price_side varchar(8),
  ADD COLUMN IF NOT EXISTS pickup_place text,
  ADD COLUMN IF NOT EXISTS customs_port text,
  ADD COLUMN IF NOT EXISTS customs_type text,
  ADD COLUMN IF NOT EXISTS vehicle_type text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'service_rates_price_side_chk'
  ) THEN
    ALTER TABLE service_rates
      ADD CONSTRAINT service_rates_price_side_chk
      CHECK (price_side IS NULL OR price_side IN ('cost','sell'));
  END IF;
END $$;
