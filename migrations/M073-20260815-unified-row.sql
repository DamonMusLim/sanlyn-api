-- M073 商品经营行 contract
-- 选择物化销量汇总：六个页面都会读销量窗口，直接扫 stock_ledger 会重；每天刷新 rollup 更稳。

DROP VIEW IF EXISTS petstore_ops_row;
DROP MATERIALIZED VIEW IF EXISTS petstore_sales_rollup;

CREATE MATERIALIZED VIEW petstore_sales_rollup AS
WITH sales AS (
  SELECT
    product_code,
    sum(CASE WHEN change_time >= now() - interval '1 day'
      THEN CASE WHEN delta < 0 THEN -delta ELSE delta END ELSE 0 END)::numeric AS sales_1d,
    sum(CASE WHEN change_time >= now() - interval '7 days'
      THEN CASE WHEN delta < 0 THEN -delta ELSE delta END ELSE 0 END)::numeric AS sales_7d,
    sum(CASE WHEN change_time >= now() - interval '30 days'
      THEN CASE WHEN delta < 0 THEN -delta ELSE delta END ELSE 0 END)::numeric AS sales_30d,
    sum(CASE WHEN change_time >= now() - interval '90 days'
      THEN CASE WHEN delta < 0 THEN -delta ELSE delta END ELSE 0 END)::numeric AS sales_90d,
    max(change_time) AS last_sale_at
  FROM petstore_stock_ledger
  WHERE order_type = 'XS'
  GROUP BY product_code
),
stock_ranked AS (
  SELECT
    product_code,
    stock_after,
    change_time,
    row_number() OVER (
      PARTITION BY product_code
      ORDER BY change_time DESC, src_id DESC
    ) AS rn
  FROM petstore_stock_ledger
),
stock_latest AS (
  SELECT
    product_code,
    stock_after,
    change_time
  FROM stock_ranked
  WHERE rn = 1
)
SELECT
  COALESCE(s.product_code, st.product_code) AS product_code,
  COALESCE(s.sales_1d, 0)::numeric AS sales_1d,
  COALESCE(s.sales_7d, 0)::numeric AS sales_7d,
  COALESCE(s.sales_30d, 0)::numeric AS sales_30d,
  COALESCE(s.sales_90d, 0)::numeric AS sales_90d,
  round((COALESCE(s.sales_90d, 0) / 90.0)::numeric, 2) AS daily_avg_90,
  st.stock_after::numeric AS cur_stock,
  CASE
    WHEN COALESCE(s.sales_90d, 0) > 0 AND st.stock_after IS NOT NULL
      THEN round((st.stock_after::numeric / (s.sales_90d / 90.0))::numeric, 2)
    ELSE NULL
  END AS days_of_supply,
  s.last_sale_at,
  st.change_time AS stock_captured_at
FROM sales s
FULL JOIN stock_latest st
  ON st.product_code = s.product_code;

CREATE UNIQUE INDEX idx_petstore_sales_rollup_code
  ON petstore_sales_rollup (product_code);

CREATE OR REPLACE FUNCTION petstore_refresh_sales_rollup()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW petstore_sales_rollup;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE VIEW petstore_ops_row AS
WITH sku AS (
  SELECT DISTINCT ON (product_code)
    product_code,
    product_name,
    category,
    spec AS spec_text,
    cost_price,
    out_price,
    NULLIF(regexp_replace(COALESCE(shelf_list, ''), '[\[\]"]', '', 'g'), '') AS shelf_code,
    (COALESCE(NULLIF(regexp_replace(COALESCE(shelf_list, ''), '[\[\]"\s]', '', 'g'), ''), '') = '') AS shelf_missing,
    supplier,
    own_brand,
    snapshot_date
  FROM petstore_skus
  WHERE product_code IS NOT NULL
  ORDER BY product_code, snapshot_date DESC NULLS LAST
),
bc AS (
  SELECT DISTINCT ON (product_code)
    product_code,
    barcode
  FROM petstore_pricing_log
  WHERE product_code IS NOT NULL
    AND barcode IS NOT NULL
  ORDER BY product_code, id DESC
),
price_today AS (
  SELECT DISTINCT ON (product_code)
    *
  FROM petstore_pricing_daily
  WHERE log_date = current_date
    AND product_code IS NOT NULL
  ORDER BY product_code, src_log_id DESC NULLS LAST
),
price_src AS (
  SELECT l.*
  FROM petstore_pricing_log l
  JOIN price_today d ON d.src_log_id = l.id
),
pic AS (
  SELECT DISTINCT ON (product_code)
    product_code,
    pic_url
  FROM petstore_pricing_log
  WHERE product_code IS NOT NULL
    AND pic_url IS NOT NULL
  ORDER BY product_code, id DESC
),
market_pick AS (
  SELECT *
  FROM (
    SELECT
      q.*,
      row_number() OVER (
        PARTITION BY q.product_code
        ORDER BY COALESCE(q.monthly_sales, 0) DESC, q.captured_at DESC, q.id DESC
      ) AS rn
    FROM petstore_valid_quotes q
    WHERE COALESCE(q.is_soft_excluded, false) = false
  ) x
  WHERE rn = 1
),
market_cnt AS (
  SELECT
    q.product_code,
    count(*)::int AS market_quote_cnt,
    count(*) FILTER (
      WHERE q.is_comparable = true
        AND COALESCE(q.exclude_reason, '') <> 'LOW_MONTHLY_SALES'
    )::int AS market_valid_cnt,
    count(*) FILTER (WHERE q.exclude_reason IS NOT NULL)::int AS market_excluded_cnt
  FROM petstore_market_quotes q
  GROUP BY q.product_code
),
pending AS (
  SELECT
    product_code,
    array_agg(DISTINCT problem_type) FILTER (WHERE problem_type IS NOT NULL) AS problem_types,
    count(*)::int AS pending_card_cnt,
    min(days_left) AS days_left,
    (array_agg(expiry_flag ORDER BY ts DESC, id DESC) FILTER (WHERE expiry_flag IS NOT NULL))[1] AS expiry_flag,
    (array_agg(pic_url ORDER BY ts DESC, id DESC) FILTER (WHERE pic_url IS NOT NULL))[1] AS pic_url
  FROM petstore_pricing_log
  WHERE exec_status = 'pending'
  GROUP BY product_code
),
dna AS (
  SELECT DISTINCT ON (product_code)
    product_code,
    restock_verdict,
    restock_qty,
    as_of
  FROM petstore_sku_sales_dna
  ORDER BY product_code, as_of DESC
),
lock_row AS (
  SELECT DISTINCT ON (product_code)
    product_code,
    locked,
    reason
  FROM petstore_price_lock
  ORDER BY product_code
)
SELECT
  s.product_code,
  bc.barcode,
  s.product_name,
  s.category,
  s.spec_text,
  COALESCE(p.pic_url, ps.pic_url, pic.pic_url) AS pic_url,
  s.supplier,
  s.own_brand,
  COALESCE(l.locked, false) AS is_locked_price,
  l.reason AS lock_reason,

  round(s.out_price::numeric, 2) AS store_price,
  round(ps.mt_price::numeric, 2) AS mt_price,
  round(ps.ele_price::numeric, 2) AS ele_price,
  round(s.cost_price::numeric, 2) AS cost_price,
  d.price_status,
  d.src_log_id,

  round(m.price::numeric, 2) AS market_price,
  m.store_name AS market_store,
  m.monthly_sales AS market_sold,
  m.spec_text AS market_spec,
  m.captured_at AS market_captured_at,
  COALESCE(mc.market_quote_cnt, 0) AS market_quote_cnt,
  COALESCE(mc.market_valid_cnt, 0) AS market_valid_cnt,
  COALESCE(mc.market_excluded_cnt, 0) AS market_excluded_cnt,

  COALESCE(r.sales_1d, 0) AS sales_1d,
  COALESCE(r.sales_7d, 0) AS sales_7d,
  COALESCE(r.sales_30d, 0) AS sales_30d,
  COALESCE(r.sales_90d, 0) AS sales_90d,
  COALESCE(r.daily_avg_90, 0) AS daily_avg_90,
  r.cur_stock,
  r.days_of_supply,
  COALESCE(ps.days_left, p.days_left) AS days_left,
  r.last_sale_at,

  COALESCE(p.problem_types, ARRAY[]::text[]) AS problem_types,
  COALESCE(p.pending_card_cnt, 0) AS pending_card_cnt,
  dna.restock_verdict,
  dna.restock_qty,
  s.shelf_code,
  s.shelf_missing,
  COALESCE(ps.expiry_flag, p.expiry_flag) AS expiry_flag,

  'petstore_stock_ledger'::text AS sales_src,
  'petstore_stock_ledger'::text AS stock_src,
  m.id AS market_src_id,
  now() AS as_of
FROM sku s
LEFT JOIN bc ON bc.product_code = s.product_code
LEFT JOIN price_today d ON d.product_code = s.product_code
LEFT JOIN price_src ps ON ps.id = d.src_log_id
LEFT JOIN pic ON pic.product_code = s.product_code
LEFT JOIN market_pick m ON m.product_code = s.product_code
LEFT JOIN market_cnt mc ON mc.product_code = s.product_code
LEFT JOIN petstore_sales_rollup r ON r.product_code = s.product_code
LEFT JOIN pending p ON p.product_code = s.product_code
LEFT JOIN dna ON dna.product_code = s.product_code
LEFT JOIN lock_row l ON l.product_code = s.product_code;

SELECT 'rollup_dup' chk, count(*) FROM (SELECT product_code FROM petstore_sales_rollup GROUP BY 1 HAVING count(*) > 1) t;
SELECT 'ops_row_cnt' chk, count(*) FROM petstore_ops_row;
SELECT 'ops_row_dup' chk, count(*) FROM (SELECT product_code FROM petstore_ops_row GROUP BY 1 HAVING count(*) > 1) t;
