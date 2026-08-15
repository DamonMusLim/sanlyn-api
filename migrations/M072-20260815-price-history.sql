-- M072 价格历史与市场报价历史
-- 可重复执行；只照抄真实字段，不猜值；SQL_ASCII 环境避免截取中文。

CREATE TABLE IF NOT EXISTS petstore_price_history (
  id bigserial PRIMARY KEY,
  product_code text NOT NULL,
  barcode text,
  channel text NOT NULL,
  price numeric(12,2) NOT NULL,
  price_type text NOT NULL CHECK (price_type IN ('生效','待批','预览')),
  source_table text NOT NULL,
  source_id bigint NOT NULL,
  effective_at timestamptz NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  is_effective boolean NOT NULL DEFAULT false,
  exec_status text,
  result text,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'petstore_price_history_uniq'
  ) THEN
    ALTER TABLE petstore_price_history
      DROP CONSTRAINT petstore_price_history_uniq;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS petstore_price_history_uniq
  ON petstore_price_history (
    product_code,
    COALESCE(channel, ''),
    effective_at,
    price_type
  );

CREATE INDEX IF NOT EXISTS idx_petstore_price_history_code_time
  ON petstore_price_history (product_code, effective_at DESC);

CREATE INDEX IF NOT EXISTS idx_petstore_price_history_source
  ON petstore_price_history (source_table, source_id);

CREATE TABLE IF NOT EXISTS petstore_market_quote_history (
  id bigserial PRIMARY KEY,
  product_code text NOT NULL,
  quote_id bigint NOT NULL,
  store_name text NOT NULL,
  source_tier text,
  price numeric(12,2),
  orig_price numeric(12,2),
  spec_text text NOT NULL DEFAULT '',
  qty_g numeric,
  unit_price numeric(12,2),
  monthly_sales numeric,
  match_conf text,
  captured_at timestamptz,
  is_comparable boolean,
  exclude_reason text,
  rule_version text,
  day_key date NOT NULL
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'petstore_market_quote_history_uniq'
  ) THEN
    ALTER TABLE petstore_market_quote_history
      DROP CONSTRAINT petstore_market_quote_history_uniq;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS petstore_market_quote_history_uniq
  ON petstore_market_quote_history (
    product_code,
    COALESCE(store_name, ''),
    COALESCE(spec_text, ''),
    day_key
  );

CREATE INDEX IF NOT EXISTS idx_petstore_market_quote_history_code_day
  ON petstore_market_quote_history (product_code, day_key DESC);

CREATE INDEX IF NOT EXISTS idx_petstore_market_quote_history_quote
  ON petstore_market_quote_history (quote_id);

CREATE OR REPLACE FUNCTION petstore_sync_price_history()
RETURNS TABLE(inserted_count integer) AS $$
BEGIN
  INSERT INTO petstore_price_history (
    product_code, barcode, channel, price, price_type,
    source_table, source_id, effective_at, captured_at,
    is_effective, exec_status, result
  )
  SELECT DISTINCT ON (
    l.product_code,
    COALESCE(NULLIF(l.channel, ''), '未知'),
    COALESCE(l.executed_at, l.confirmed_at, l.ts, now()),
    '生效'
  )
    l.product_code,
    l.barcode,
    COALESCE(NULLIF(l.channel, ''), '未知') AS channel,
    round(l.new_price::numeric, 2) AS price,
    '生效' AS price_type,
    'petstore_pricing_log' AS source_table,
    l.id AS source_id,
    COALESCE(l.executed_at, l.confirmed_at, l.ts, now()) AS effective_at,
    COALESCE(l.synced_at, l.ts, now()) AS captured_at,
    true AS is_effective,
    l.exec_status,
    l.result
  FROM petstore_pricing_log l
  WHERE l.result LIKE '生效%'
    AND l.product_code IS NOT NULL
    AND l.new_price IS NOT NULL
  ORDER BY
    l.product_code,
    COALESCE(NULLIF(l.channel, ''), '未知'),
    COALESCE(l.executed_at, l.confirmed_at, l.ts, now()),
    '生效',
    COALESCE(l.synced_at, l.ts, now()) DESC,
    l.id DESC
  ON CONFLICT (
    product_code,
    COALESCE(channel, ''),
    effective_at,
    price_type
  ) DO NOTHING;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION petstore_sync_market_quote_history()
RETURNS TABLE(upserted_count integer) AS $$
BEGIN
  INSERT INTO petstore_market_quote_history (
    product_code, quote_id, store_name, source_tier, price, orig_price,
    spec_text, qty_g, unit_price, monthly_sales, match_conf, captured_at,
    is_comparable, exclude_reason, rule_version, day_key
  )
  SELECT DISTINCT ON (
    q.product_code,
    COALESCE(NULLIF(q.store_name, ''), '未知'),
    COALESCE(q.spec_text, ''),
    COALESCE(q.captured_at::date, current_date)
  )
    q.product_code,
    q.id AS quote_id,
    COALESCE(NULLIF(q.store_name, ''), '未知') AS store_name,
    q.source_tier,
    round(q.price::numeric, 2),
    round(q.orig_price::numeric, 2),
    COALESCE(q.spec_text, '') AS spec_text,
    q.qty_g,
    round(q.unit_price::numeric, 2),
    q.monthly_sales,
    q.match_conf,
    q.captured_at,
    q.is_comparable,
    q.exclude_reason,
    q.rule_version,
    COALESCE(q.captured_at::date, current_date) AS day_key
  FROM petstore_market_quotes q
  WHERE q.product_code IS NOT NULL
  ORDER BY
    q.product_code,
    COALESCE(NULLIF(q.store_name, ''), '未知'),
    COALESCE(q.spec_text, ''),
    COALESCE(q.captured_at::date, current_date),
    q.captured_at DESC NULLS LAST,
    q.id DESC
  ON CONFLICT (
    product_code,
    COALESCE(store_name, ''),
    COALESCE(spec_text, ''),
    day_key
  ) DO UPDATE SET
    quote_id = EXCLUDED.quote_id,
    source_tier = EXCLUDED.source_tier,
    price = EXCLUDED.price,
    orig_price = EXCLUDED.orig_price,
    qty_g = EXCLUDED.qty_g,
    unit_price = EXCLUDED.unit_price,
    monthly_sales = EXCLUDED.monthly_sales,
    match_conf = EXCLUDED.match_conf,
    captured_at = EXCLUDED.captured_at,
    is_comparable = EXCLUDED.is_comparable,
    exclude_reason = EXCLUDED.exclude_reason,
    rule_version = EXCLUDED.rule_version
  WHERE petstore_market_quote_history.captured_at IS NULL
     OR EXCLUDED.captured_at IS NULL
     OR EXCLUDED.captured_at >= petstore_market_quote_history.captured_at;

  GET DIAGNOSTICS upserted_count = ROW_COUNT;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;

-- 首次回填；之后 cron 每天执行这两个函数即可。
SELECT * FROM petstore_sync_price_history();
SELECT * FROM petstore_sync_market_quote_history();

SELECT 'petstore_price_history' AS table_name, count(*)::int AS row_count
FROM petstore_price_history
UNION ALL
SELECT 'petstore_market_quote_history' AS table_name, count(*)::int AS row_count
FROM petstore_market_quote_history;

SELECT 'price_history_latest_day' AS chk, count(*)::int AS row_count
FROM petstore_price_history
WHERE effective_at::date = (
  SELECT max(effective_at::date) FROM petstore_price_history
)
UNION ALL
SELECT 'quote_history_latest_day' AS chk, count(*)::int AS row_count
FROM petstore_market_quote_history
WHERE day_key = (
  SELECT max(day_key) FROM petstore_market_quote_history
);

SELECT 'price_history_dup' AS chk, count(*)::int
FROM (
  SELECT product_code, COALESCE(channel, ''), effective_at, price_type, count(*) c
  FROM petstore_price_history
  GROUP BY 1,2,3,4
  HAVING count(*) > 1
) t
UNION ALL
SELECT 'quote_history_dup' AS chk, count(*)::int
FROM (
  SELECT product_code, COALESCE(store_name, ''), COALESCE(spec_text, ''), day_key, count(*) c
  FROM petstore_market_quote_history
  GROUP BY 1,2,3,4
  HAVING count(*) > 1
) t;
