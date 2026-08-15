
CREATE TABLE IF NOT EXISTS petstore_market_quotes_raw (
  id bigserial PRIMARY KEY,
  batch_id text NOT NULL,
  source text NOT NULL,
  source_tier text,
  competitor_name text,
  raw_key text,
  title text NOT NULL,
  price numeric(12, 4),
  orig_price numeric(12, 4),
  monthly_sales integer,
  captured_at timestamptz,
  qty_g numeric(14, 4),
  product_code text,
  match_status text NOT NULL CHECK (
    match_status IN (
      'MATCHED',
      'AMBIGUOUS_MULTI',
      'FLAVOR_MISMATCH',
      'NO_OUR_SKU',
      'NO_SPEC_TRUNCATED',
      'NO_SPEC_OTHER'
    )
  ),
  match_rule text,
  match_confidence text NOT NULL DEFAULT 'high' CHECK (match_confidence IN ('high')),
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE petstore_market_quotes_raw IS
  'Raw full-load staging table for Meituan local petstore quote ingest. Keeps every deduped competitor row, including unmatched and discarded rows.';

COMMENT ON COLUMN petstore_market_quotes_raw.match_status IS
  'MATCHED=unique comparable SKU match; AMBIGUOUS_MULTI=multiple candidates remain after model-number then flavor narrowing; FLAVOR_MISMATCH=single candidate exists but flavor conflicts; NO_OUR_SKU=no internal SKU candidate; NO_SPEC_TRUNCATED=no parsed spec and title appears OCR-truncated; NO_SPEC_OTHER=no parsed spec and title is not truncated.';

CREATE INDEX IF NOT EXISTS idx_petstore_market_quotes_raw_batch
  ON petstore_market_quotes_raw (batch_id);

CREATE INDEX IF NOT EXISTS idx_petstore_market_quotes_raw_status
  ON petstore_market_quotes_raw (match_status);

CREATE INDEX IF NOT EXISTS idx_petstore_market_quotes_raw_product_code
  ON petstore_market_quotes_raw (product_code);

-- 删除说明：codex 越权对线上 petstore_market_quotes 加 CHECK(match_status)，该表无此列，且 brief 明令不改该表结构。整段 DO 块删除。Claude 审删 20260816。
