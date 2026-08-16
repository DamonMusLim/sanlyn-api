// api/db/petstore-pricing-rivals.mjs
export const RIVALS_CTES = `market_scope AS MATERIALIZED (
  SELECT q.*
  FROM petstore_market_quotes q
  JOIN (SELECT DISTINCT product_code FROM picked) p ON p.product_code = q.product_code
  WHERE q.source IN ('meituan_local', 'taobao', 'pdd')
),
local_stats AS MATERIALIZED (
  SELECT
    product_code,
    COUNT(*) FILTER (WHERE is_comparable IS TRUE)::int AS cnt,
    MIN(price) FILTER (WHERE is_comparable IS TRUE) AS min_price,
    (array_agg(store_name ORDER BY price NULLS LAST, captured_at DESC)
      FILTER (WHERE is_comparable IS TRUE))[1] AS min_store,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY price)
      FILTER (WHERE is_comparable IS TRUE)::numeric AS median_price,
    (array_agg(captured_at ORDER BY price NULLS LAST, captured_at DESC)
      FILTER (WHERE is_comparable IS TRUE))[1] AS captured_at
  FROM market_scope
  WHERE source = 'meituan_local'
  GROUP BY product_code
),
local_ranked AS MATERIALIZED (
  SELECT
    product_code, store_name, matched_title, spec_text, price, orig_price,
    is_comparable, exclude_reason, captured_at,
    row_number() OVER (
      PARTITION BY product_code
      ORDER BY is_comparable DESC, price NULLS LAST, captured_at DESC
    ) AS rn
  FROM market_scope
  WHERE source = 'meituan_local'
),
local_items AS MATERIALIZED (
  SELECT product_code,
    jsonb_agg(jsonb_build_object(
      'store', store_name,
      'title', matched_title,
      'spec', spec_text,
      'price', price,
      'orig_price', orig_price,
      'is_comparable', is_comparable,
      'exclude_reason', exclude_reason,
      'captured_at', captured_at
    ) ORDER BY rn) AS items
  FROM local_ranked
  WHERE rn <= 5
  GROUP BY product_code
),
online_stats AS MATERIALIZED (
  SELECT
    product_code,
    COUNT(*) FILTER (WHERE is_comparable IS TRUE)::int AS cnt,
    MIN(price) FILTER (WHERE is_comparable IS TRUE) AS min_price,
    (array_agg(source ORDER BY price NULLS LAST, captured_at DESC)
      FILTER (WHERE is_comparable IS TRUE))[1] AS platform,
    (array_agg(captured_at ORDER BY price NULLS LAST, captured_at DESC)
      FILTER (WHERE is_comparable IS TRUE))[1] AS captured_at
  FROM market_scope
  WHERE source IN ('taobao', 'pdd')
  GROUP BY product_code
)`;

export const RIVALS_SELECT = `jsonb_build_object(
    'local', CASE
      WHEN COALESCE(ls.cnt, 0) > 0 THEN jsonb_build_object(
        'cnt', ls.cnt,
        'min_price', ls.min_price,
        'min_store', ls.min_store,
        'median_price', round(ls.median_price, 2),
        'captured_at', ls.captured_at,
        'items', COALESCE(li.items, '[]'::jsonb)
      )
      WHEN li.items IS NOT NULL THEN jsonb_build_object(
        'cnt', 0,
        'min_price', NULL,
        'min_store', NULL,
        'median_price', NULL,
        'captured_at', NULL,
        'items', li.items
      )
      ELSE NULL
    END,
    'online', CASE
      WHEN COALESCE(os.cnt, 0) > 0 THEN jsonb_build_object(
        'cnt', os.cnt,
        'min_price', os.min_price,
        'platform', os.platform,
        'captured_at', os.captured_at
      )
      ELSE NULL
    END
  ) AS rivals,`;

export const RIVALS_JOINS = `LEFT JOIN local_stats ls ON ls.product_code = p.product_code
LEFT JOIN local_items li ON li.product_code = p.product_code
LEFT JOIN online_stats os ON os.product_code = p.product_code`;
