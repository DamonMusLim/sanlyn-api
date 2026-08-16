-- M078-20260816-market-quote-ingest-runs.sql

CREATE TABLE IF NOT EXISTS petstore_market_quote_ingest_runs (
  run_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL,
  sku_total INT NOT NULL DEFAULT 0,
  sku_success INT NOT NULL DEFAULT 0,
  sku_failed INT NOT NULL DEFAULT 0,
  quote_inserted INT NOT NULL DEFAULT 0,
  comparable_count INT NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  sample_product_codes TEXT[],
  rule_version TEXT,
  CONSTRAINT petstore_market_quote_ingest_runs_status_chk
    CHECK (status IN ('running','ok','failed'))
);

CREATE INDEX IF NOT EXISTS ix_pmqir_source_started
  ON petstore_market_quote_ingest_runs(source, started_at DESC);

ALTER TABLE petstore_market_quotes
  ADD COLUMN IF NOT EXISTS price_type TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'petstore_market_quotes_price_type_chk'
  ) THEN
    ALTER TABLE petstore_market_quotes
      ADD CONSTRAINT petstore_market_quotes_price_type_chk
      CHECK (
        price_type IS NULL OR price_type IN ('representative','lure_trap','anchor')
      );
  END IF;
END $$;
