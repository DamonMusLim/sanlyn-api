-- M071 真实性与排除契约
-- 目标：每个展示报价都可追溯到 petstore_market_quotes 唯一源行；脏数据保留审计但不进主决策。

ALTER TABLE petstore_market_quotes
  ADD COLUMN IF NOT EXISTS qty_g numeric,
  ADD COLUMN IF NOT EXISTS unit_price numeric,
  ADD COLUMN IF NOT EXISTS is_comparable boolean,
  ADD COLUMN IF NOT EXISTS exclude_reason text,
  ADD COLUMN IF NOT EXISTS rule_version text;

WITH parsed AS (
  SELECT
    id,
    COALESCE(spec_text, matched_title, '') AS raw_text
  FROM petstore_market_quotes
),
picked AS (
  SELECT
    id,
    raw_text,
    regexp_match(
      raw_text,
      '([0-9]+(?:\.[0-9]+)?)\s*(kg|KG|Kg|g|G|克|ml|ML|Ml|l|L|升|斤)\s*(?:[*xX×]\s*([0-9]+(?:\.[0-9]+)?))?'
    ) AS m
  FROM parsed
),
qty AS (
  SELECT
    id,
    CASE
      WHEN m IS NULL THEN NULL
      WHEN m[2] IN ('kg','KG','Kg') THEN (m[1])::numeric * 1000 * COALESCE(NULLIF(m[3], '')::numeric, 1)
      WHEN m[2] IN ('g','G','克','ml','ML','Ml') THEN (m[1])::numeric * COALESCE(NULLIF(m[3], '')::numeric, 1)
      WHEN m[2] IN ('l','L','升') THEN (m[1])::numeric * 1000 * COALESCE(NULLIF(m[3], '')::numeric, 1)
      WHEN m[2] = '斤' THEN (m[1])::numeric * 500 * COALESCE(NULLIF(m[3], '')::numeric, 1)
      ELSE NULL
    END AS qty_g
  FROM picked
)
UPDATE petstore_market_quotes q
SET qty_g = qty.qty_g,
    unit_price = CASE
      WHEN qty.qty_g > 0 AND q.price IS NOT NULL THEN q.price / (qty.qty_g / 1000)
      ELSE NULL
    END,
    rule_version = 'truth_exclusion_v2026.08.15-1'
FROM qty
WHERE q.id = qty.id;

-- LOW_MONTHLY_SALES threshold: monthly_sales <= 5 is soft-excluded but still comparable.
UPDATE petstore_market_quotes
SET exclude_reason = CASE
      WHEN price > 0 AND orig_price / price > 5 THEN 'OCR_SUSPECT'
      WHEN qty_g IS NULL THEN 'MISSING_SPEC'
      WHEN match_conf = 'low' THEN 'LOW_MATCH_CONFIDENCE'
      WHEN captured_at < now() - interval '7 days' THEN 'STALE_QUOTE'
      WHEN COALESCE(monthly_sales, 0) <= 5 THEN 'LOW_MONTHLY_SALES'
      WHEN source_tier LIKE '%批发%' THEN 'WHOLESALE_NOT_COMPARABLE'
      ELSE NULL
    END,
    rule_version = 'truth_exclusion_v2026.08.15-1';

UPDATE petstore_market_quotes
SET is_comparable = (exclude_reason IS NULL OR exclude_reason = 'LOW_MONTHLY_SALES'),
    unit_price = CASE
      WHEN qty_g > 0 AND price IS NOT NULL THEN price / (qty_g / 1000)
      ELSE NULL
    END,
    rule_version = 'truth_exclusion_v2026.08.15-1';

CREATE OR REPLACE VIEW petstore_valid_quotes AS
SELECT
  q.*,
  (q.exclude_reason = 'LOW_MONTHLY_SALES') AS is_soft_excluded
FROM petstore_market_quotes q
WHERE q.is_comparable = true;

DROP VIEW IF EXISTS petstore_pricing_daily;

CREATE VIEW petstore_pricing_daily AS
WITH base AS (
  SELECT
    l.*,
    (l.result LIKE '生效%') AS is_effective,
    (COALESCE(l.result, '') LIKE '%预览%' OR COALESCE(l.result, '') ILIKE 'dry-run%') AS is_preview
  FROM petstore_pricing_log l
),
grouped AS (
  SELECT
    product_code,
    log_date,
    max(ts) AS ts,
    (array_agg(product_name ORDER BY ts DESC, id DESC))[1] AS product_name,
    (array_agg(store_name ORDER BY ts DESC, id DESC))[1] AS store_name,
    jsonb_object_agg(COALESCE(channel, '未知'), result ORDER BY ts, id) AS channel_results,
    count(*) FILTER (WHERE result LIKE '生效%')::int AS ok_cnt,
    count(*) FILTER (WHERE result LIKE '失败%')::int AS fail_cnt,
    count(*) FILTER (WHERE result LIKE '跳过%')::int AS skip_cnt,
    count(*) FILTER (WHERE exec_status IN ('pending','approved'))::int AS pending_cnt,
    count(DISTINCT channel)::int AS chan_cnt,
    array_remove(array_agg(DISTINCT channel) FILTER (WHERE is_effective), NULL) AS effective_channels,
    array_remove(array_agg(DISTINCT channel) FILTER (WHERE is_preview AND NOT is_effective), NULL) AS preview_only_channels,
    count(*) FILTER (WHERE is_effective)::int AS effective_cnt,
    count(*) FILTER (WHERE is_preview)::int AS preview_cnt,
    count(DISTINCT new_price) FILTER (WHERE is_effective AND new_price IS NOT NULL)::int AS effective_price_cnt
  FROM base
  GROUP BY product_code, log_date
),
src AS (
  SELECT DISTINCT ON (product_code, log_date)
    product_code,
    log_date,
    id AS src_log_id,
    old_price,
    new_price,
    rate,
    reason,
    days_left
  FROM base
  WHERE is_effective
  ORDER BY product_code, log_date, ts DESC, id DESC
),
preview_src AS (
  SELECT DISTINCT ON (product_code, log_date)
    product_code,
    log_date,
    new_price AS preview_new_price
  FROM base
  WHERE is_preview
  ORDER BY product_code, log_date, ts DESC, id DESC
)
SELECT
  g.product_code,
  g.log_date,
  g.ts,
  g.product_name,
  g.store_name,
  CASE WHEN g.effective_cnt > 0 AND g.effective_price_cnt = 1 THEN s.old_price ELSE NULL END AS old_price,
  CASE WHEN g.effective_cnt > 0 AND g.effective_price_cnt = 1 THEN s.new_price ELSE NULL END AS new_price,
  CASE WHEN g.effective_cnt > 0 AND g.effective_price_cnt = 1 THEN s.rate ELSE NULL END AS rate,
  COALESCE(s.reason, CASE WHEN g.effective_cnt = 0 AND g.preview_cnt > 0 THEN '预览' ELSE NULL END) AS reason,
  s.days_left,
  g.channel_results,
  g.ok_cnt,
  g.fail_cnt,
  g.skip_cnt,
  g.chan_cnt,
  CASE
    WHEN g.effective_cnt > 0 AND g.effective_price_cnt > 1 THEN '多渠道不同价'
    WHEN g.effective_cnt > 0 THEN '生效'
    WHEN g.preview_cnt > 0 THEN '仅预览'
    WHEN g.pending_cnt > 0 THEN '待批'
    ELSE '无'
  END AS price_status,
  g.effective_channels,
  g.preview_only_channels,
  CASE WHEN g.effective_cnt > 0 AND g.effective_price_cnt = 1 THEN s.src_log_id ELSE NULL END AS src_log_id,
  CASE WHEN g.effective_cnt = 0 AND g.preview_cnt > 0 THEN p.preview_new_price ELSE NULL END AS preview_new_price
FROM grouped g
LEFT JOIN src s ON s.product_code = g.product_code AND s.log_date = g.log_date
LEFT JOIN preview_src p ON p.product_code = g.product_code AND p.log_date = g.log_date;

SELECT
  COALESCE(exclude_reason, 'INCLUDED') AS exclude_reason,
  count(*)::int AS n
FROM petstore_market_quotes
GROUP BY COALESCE(exclude_reason, 'INCLUDED')
ORDER BY n DESC, exclude_reason;
