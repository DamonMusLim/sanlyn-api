-- M101: shipping_plans cost currency and cost evidence status.
-- Review-only migration. No transaction terminator; run inside an outer BEGIN/ROLLBACK for dry-run validation.

DO $$
DECLARE
  currency_type text;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod)
    INTO currency_type
    FROM pg_attribute a
   WHERE a.attrelid = 'shipping_plans'::regclass
     AND a.attname = 'freight_sale_currency'
     AND NOT a.attisdropped;

  IF currency_type IS NULL THEN
    currency_type := 'text';
  END IF;

  EXECUTE format(
    'ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS freight_cost_currency %s',
    currency_type
  );
END $$;

ALTER TABLE shipping_plans
  ADD COLUMN IF NOT EXISTS cost_evidence_status text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'shipping_plans'::regclass
       AND conname = 'shipping_plans_cost_evidence_status_chk'
  ) THEN
    ALTER TABLE shipping_plans
      ADD CONSTRAINT shipping_plans_cost_evidence_status_chk
      CHECK (
        cost_evidence_status IS NULL OR cost_evidence_status IN (
          'supplier_bill_confirmed',
          'supplier_bill_missing',
          'ar_inferred_currency_only',
          'zero_margin_confirmed'
        )
      );
  END IF;
END $$;

UPDATE shipping_plans
   SET freight_cost_currency = COALESCE(
         NULLIF(BTRIM(freight_cost_currency::text), ''),
         'USD'
       ),
       cost_evidence_status = COALESCE(
         NULLIF(BTRIM(cost_evidence_status), ''),
         'zero_margin_confirmed'
       ),
       updated_at = now()
 WHERE deleted_at IS NULL
   AND (
     _id = 'KMTCTAO8365712B'
     OR shipment_no = 'KMTCTAO8365712B'
     OR bl_no = 'KMTCTAO8365712B'
   )
   AND COALESCE(raw, '{}'::jsonb) @> '{"freight_cost_currency":"USD","cost_evidence_status":"zero_margin_confirmed"}'::jsonb;
