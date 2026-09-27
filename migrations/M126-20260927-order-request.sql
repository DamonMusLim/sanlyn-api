BEGIN;

CREATE TABLE IF NOT EXISTS order_request (
  id text PRIMARY KEY,
  channel text NOT NULL,
  buyer_company_code text,
  factory_company_code text,
  submitted_by_uid text,
  submitted_by_username text,
  source text,
  status text NOT NULL DEFAULT 'submitted',
  lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  requested_delivery date,
  customer_po text,
  container text,
  remarks text,
  files jsonb NOT NULL DEFAULT '[]'::jsonb,
  review jsonb NOT NULL DEFAULT '{}'::jsonb,
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,   -- 收货人/地址/目的港（客户、我方），工厂最早可交货日（工厂）
  order_no text,
  return_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_request_channel_check'
  ) THEN
    ALTER TABLE order_request
      ADD CONSTRAINT order_request_channel_check
      CHECK (channel IN ('customer','internal','factory'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_request_status_check'
  ) THEN
    ALTER TABLE order_request
      ADD CONSTRAINT order_request_status_check
      CHECK (status IN ('submitted','reviewing','returned','confirmed','cancelled'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS order_request_buyer_idx
  ON order_request (buyer_company_code, created_at DESC);
CREATE INDEX IF NOT EXISTS order_request_factory_idx
  ON order_request (factory_company_code, created_at DESC);
CREATE INDEX IF NOT EXISTS order_request_status_idx
  ON order_request (status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS order_request_order_no_uniq
  ON order_request (order_no) WHERE order_no IS NOT NULL;

COMMIT;
