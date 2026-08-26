-- M106: fee entry fields aligned to HGJ measured columns.
-- Nullable only. Existing freight_supplier_bills rows are intentionally not backfilled.

ALTER TABLE freight_supplier_bills
  ADD COLUMN IF NOT EXISTS settlement_company text,
  ADD COLUMN IF NOT EXISTS exchange_rate numeric,
  ADD COLUMN IF NOT EXISTS total_price numeric,
  ADD COLUMN IF NOT EXISTS tax_rate numeric,
  ADD COLUMN IF NOT EXISTS tax_amount numeric,
  ADD COLUMN IF NOT EXISTS calculation_formula text,
  ADD COLUMN IF NOT EXISTS fee_status text,
  ADD COLUMN IF NOT EXISTS sort_order integer;
