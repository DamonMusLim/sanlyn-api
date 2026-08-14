ALTER TABLE petstore_pricing_log
  ADD COLUMN IF NOT EXISTS damon_online_price NUMERIC,
  ADD COLUMN IF NOT EXISTS damon_context JSONB;
