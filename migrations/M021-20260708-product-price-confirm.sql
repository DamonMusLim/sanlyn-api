BEGIN;
ALTER TABLE factory_confirmations
  ADD COLUMN IF NOT EXISTS confirmation_kind TEXT NOT NULL DEFAULT 'factory_delivery',
  ADD COLUMN IF NOT EXISTS confirmed_price_lines JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS confirmed_factory_amount NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS confirmed_currency TEXT,
  ADD COLUMN IF NOT EXISTS uploaded_files JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS price_changed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending','auto_accepted','needs_internal_review','accepted','rejected'));
ALTER TABLE factory_confirmations DROP CONSTRAINT IF EXISTS factory_confirmations_source_check;
ALTER TABLE factory_confirmations ADD CONSTRAINT factory_confirmations_source_check
  CHECK (source IN ('token','portal','magic_link'));
CREATE INDEX IF NOT EXISTS idx_factory_confirmations_kind_order ON factory_confirmations(order_no, confirmation_kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_factory_confirmations_review ON factory_confirmations(review_status, created_at DESC);
COMMIT;
