ALTER TABLE petstore_market_quotes_raw
  ADD COLUMN IF NOT EXISTS parsed_brand text,
  ADD COLUMN IF NOT EXISTS parsed_unit_count integer,
  ADD COLUMN IF NOT EXISTS parsed_unit_qty_g numeric,
  ADD COLUMN IF NOT EXISTS parsed_flavors text[],
  ADD COLUMN IF NOT EXISTS is_title_truncated boolean;

CREATE INDEX IF NOT EXISTS idx_petstore_market_quotes_raw_parsed_brand
  ON petstore_market_quotes_raw(parsed_brand);
