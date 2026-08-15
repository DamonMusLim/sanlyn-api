ALTER TABLE petstore_market_quotes_raw
  DROP CONSTRAINT IF EXISTS petstore_market_quotes_raw_match_status_check;

ALTER TABLE petstore_market_quotes_raw
  ADD CONSTRAINT petstore_market_quotes_raw_match_status_check
  CHECK (match_status IN (
    'MATCHED',
    'AMBIGUOUS_MULTI',
    'FLAVOR_MISMATCH',
    'NO_OUR_SKU',
    'NO_SPEC_TRUNCATED',
    'NO_SPEC_OTHER',
    'NO_BRAND'
  ));
