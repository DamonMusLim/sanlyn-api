-- 2026-09-06 forwarder portal preferred carriers.
-- Manual annotation only: values must come from Damon review / forwarder self-report review / carrier agency evidence.
-- This column is not inferred from price, historical rate level, or shipment volume.

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS preferred_carriers text[];

COMMENT ON COLUMN public.companies.preferred_carriers IS
  'Manual preferred/first-hand carrier labels for forwarder portal display; not inferred from prices or history.';
