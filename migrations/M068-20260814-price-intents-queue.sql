CREATE TABLE IF NOT EXISTS petstore_price_intents (
  id BIGSERIAL PRIMARY KEY,
  product_code TEXT NOT NULL,
  product_name TEXT,
  channel TEXT NOT NULL DEFAULT '门店',
  old_price NUMERIC,
  target_price NUMERIC NOT NULL,
  reason TEXT,
  author TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  applied_at TIMESTAMPTZ,
  worker_id TEXT,
  claimed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ppi_open ON petstore_price_intents(product_code, channel)
  WHERE status IN ('proposed','mgr_ok','approved','pending','applying');
CREATE INDEX IF NOT EXISTS ix_ppi_pending ON petstore_price_intents(status, created_at);
CREATE INDEX IF NOT EXISTS ix_ppi_code ON petstore_price_intents(product_code, created_at DESC);
