ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS payment_consolidation boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS payment_batches (
  id serial PRIMARY KEY,
  seller_company_code varchar(80) NOT NULL,
  buyer_company_code varchar(80) NOT NULL,
  currency varchar(20) NOT NULL,
  period varchar(7) NOT NULL,
  total_amount numeric NOT NULL,
  invoice_count integer NOT NULL,
  est_cost numeric,
  est_revenue numeric,
  est_profit numeric,
  profit_status varchar(20) NOT NULL,
  risk_acknowledged boolean NOT NULL DEFAULT false,
  status varchar(20) NOT NULL DEFAULT 'confirmed',
  confirmed_by varchar(80),
  confirmed_at timestamptz NOT NULL DEFAULT NOW(),
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_batch_items (
  id serial PRIMARY KEY,
  batch_id integer NOT NULL REFERENCES payment_batches(id),
  finance_invoice_in_id integer NOT NULL REFERENCES finance_invoices_in(id),
  amount numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(finance_invoice_in_id)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_batches_profit_status_chk') THEN
    ALTER TABLE payment_batches
      ADD CONSTRAINT payment_batches_profit_status_chk
      CHECK (profit_status IN ('ok','below_cost','no_profit','unknown'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_batches_status_chk') THEN
    ALTER TABLE payment_batches
      ADD CONSTRAINT payment_batches_status_chk
      CHECK (status IN ('confirmed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_payment_batches_period
  ON payment_batches (period, seller_company_code, buyer_company_code);

CREATE INDEX IF NOT EXISTS idx_payment_batch_items_batch
  ON payment_batch_items (batch_id);
