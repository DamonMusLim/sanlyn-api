-- LuvSome payment advice OCR tables. Run against sanlyn_db (shared with sanlyn-api).
-- Pure CREATE TABLE IF NOT EXISTS — no impact on existing data.

CREATE TABLE IF NOT EXISTS pet_slip_payments (
  id BIGSERIAL PRIMARY KEY,
  bank_source TEXT,
  bank_reference_no TEXT,
  txn_ref TEXT,
  sender_name TEXT,
  sender_bank TEXT,
  sender_country TEXT,
  beneficiary_name TEXT,
  beneficiary_bank TEXT,
  beneficiary_account_masked TEXT,
  amount NUMERIC(18,2),
  currency TEXT,
  indicative_amount NUMERIC(18,2),
  indicative_currency TEXT,
  exchange_rate NUMERIC(18,8),
  cable_charge NUMERIC(18,2),
  commission_charge NUMERIC(18,2),
  sst_charge NUMERIC(18,2),
  charge_currency TEXT,
  purpose_code TEXT,
  remark_details TEXT,
  beneficiary_reference TEXT,
  payment_date DATE,
  bank_processing_date DATE,
  file_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending_review',
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT,
  audit_status TEXT DEFAULT 'not_run',
  audit_risk_level TEXT,
  confirmed_by TEXT,
  confirmed_at TIMESTAMPTZ,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pet_slip_uploads (
  id BIGSERIAL PRIMARY KEY,
  filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  uploader TEXT,
  note TEXT,
  size_bytes BIGINT,
  upload_ip TEXT,
  processed BOOLEAN DEFAULT FALSE,
  slip_id BIGINT REFERENCES pet_slip_payments(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- pet_slip_links: required by slip-core.js auditAmountAllocation/auditSelectionSource
-- (ALLOWED_LINKS_TABLES whitelist). Mirrors bank_slip_links shape, order_source
-- distinguishes sale_order(线上) vs pos_order(门店POS) per Damon's 2026-07-08 priority call.
CREATE TABLE IF NOT EXISTS pet_slip_links (
  id BIGSERIAL PRIMARY KEY,
  slip_id BIGINT NOT NULL REFERENCES pet_slip_payments(id) ON DELETE CASCADE,
  order_source TEXT,          -- 'sale_order' | 'pos_order'
  order_id INTEGER,           -- Odoo record id
  order_no TEXT,
  partner_name TEXT,
  amount_alloc NUMERIC(18,2),
  alloc_currency CHAR(3),
  note TEXT,
  selection_source TEXT DEFAULT 'ocr_candidate',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pet_slip_payments_status
  ON pet_slip_payments(status);

CREATE INDEX IF NOT EXISTS idx_pet_slip_payments_bank_ref
  ON pet_slip_payments(bank_reference_no)
  WHERE bank_reference_no IS NOT NULL AND bank_reference_no <> '';

CREATE INDEX IF NOT EXISTS idx_pet_slip_uploads_processed
  ON pet_slip_uploads(processed, id);

CREATE INDEX IF NOT EXISTS idx_pet_slip_links_slip
  ON pet_slip_links(slip_id);

CREATE INDEX IF NOT EXISTS idx_pet_slip_links_order
  ON pet_slip_links(order_source, order_id);
