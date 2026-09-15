CREATE TABLE IF NOT EXISTS public.petstore_cost_override (
  product_code text PRIMARY KEY,
  cost numeric NOT NULL CHECK (cost > 0),
  source text NOT NULL,
  noted_by text NOT NULL,
  noted_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.petstore_cost_override(product_code, cost, source, noted_by)
VALUES ('6335102749', 27, 'Damon口述0915现进价(涨价)', 'damon')
ON CONFLICT (product_code) DO NOTHING;

CREATE OR REPLACE VIEW public.v_selection_shop AS
WITH h5_best AS (
  SELECT DISTINCT ON (product_code, 3)
         product_code,
         competitor_name AS shop_full,
         -- 0915 Claude审:H5全称与OCR简称要归一,否则同一家店算两遍;邻小虎思明店是另一家不归一
         CASE WHEN competitor_name LIKE '%邻小虎%' AND competitor_name LIKE '%金枋%' THEN '邻小虎'
              WHEN competitor_name LIKE '%爪壮壮%' AND competitor_name LIKE '%湖里%' THEN '爪壮壮'
              ELSE competitor_name END AS shop,
         'h5'::text AS source,
         monthly_sales::numeric AS monthly_sales,
         price::numeric AS price,
         orig_price::numeric AS orig_price,
         false AS is_first_price,
         NULL::numeric AS delivery_min,
         raw_payload->>'distance' AS distance,
         raw_payload->>'shop_month_sales' AS shop_month_sales,
         captured_at
    FROM public.petstore_market_quotes_raw
   WHERE source = 'meituan_h5'
     AND match_status = 'MATCHED'
     AND product_code IS NOT NULL
     AND competitor_name IS NOT NULL
   ORDER BY product_code, 3,
            monthly_sales DESC NULLS LAST,
            captured_at DESC NULLS LAST
),
ocr_raw AS (
  SELECT q.id,
         CASE
           WHEN q.shop_name LIKE '%爪壮壮%' THEN '爪壮壮'
           WHEN q.shop_name LIKE '%邻小虎%' THEN '邻小虎'
           ELSE q.shop_name
         END AS shop,
         q.tier_price::numeric AS price,
         q.list_price::numeric AS orig_price,
         q.tier_type,
         q.month_sale::numeric AS monthly_sales,
         q.shop_delivery_min::numeric AS shop_delivery_min,
         q.captured_at,
         m.product_code
    FROM public.petstore_rival_quotes_app q
    JOIN public.petstore_rival_app_match m ON m.quote_id = q.id
   WHERE m.match_status = 'MATCHED'
     AND m.product_code IS NOT NULL
     AND (q.shop_name LIKE '%爪壮壮%' OR q.shop_name LIKE '%邻小虎%')
),
ocr_delivery AS (
  -- 起送价是店级字段,只在少数店铺页行里有,⛔不能只从已匹配行取
  SELECT CASE WHEN shop_name LIKE '%爪壮壮%' THEN '爪壮壮' WHEN shop_name LIKE '%邻小虎%' THEN '邻小虎' END AS shop,
         max(shop_delivery_min)::numeric AS delivery_min
    FROM public.petstore_rival_quotes_app
   WHERE shop_name LIKE '%爪壮壮%' OR shop_name LIKE '%邻小虎%'
   GROUP BY 1
),
ocr_best AS (
  SELECT DISTINCT ON (product_code, shop)
         product_code,
         shop,
         'ocr'::text AS source,
         monthly_sales,
         price,
         orig_price,
         tier_type IN ('first_n','first_n_each') AS is_first_price,
         captured_at
    FROM ocr_raw
   ORDER BY product_code, shop,
            monthly_sales DESC NULLS LAST,
            captured_at DESC NULLS LAST
)
SELECT COALESCE(o.product_code, h.product_code) AS product_code,
       COALESCE(o.shop, h.shop) AS shop,
       CASE WHEN o.product_code IS NOT NULL THEN 'ocr' ELSE 'h5' END AS source,
       COALESCE(o.monthly_sales, h.monthly_sales) AS monthly_sales,
       COALESCE(o.price, h.price) AS price,
       COALESCE(o.orig_price, h.orig_price) AS orig_price,
       COALESCE(o.is_first_price, false) AS is_first_price,
       d.delivery_min,
       h.distance,
       h.shop_month_sales,
       COALESCE(o.captured_at, h.captured_at) AS captured_at
  FROM ocr_best o
  FULL JOIN h5_best h
    ON h.product_code = o.product_code
   AND h.shop = o.shop
  LEFT JOIN ocr_delivery d
    ON d.shop = COALESCE(o.shop, h.shop);

CREATE OR REPLACE VIEW public.v_selection_rows AS
WITH ops AS (
  SELECT DISTINCT ON (product_code)
         product_code,
         product_name AS our_name,
         spec_text,
         store_price::numeric AS our_store_price,
         mt_price::numeric AS our_mt_price
    FROM public.petstore_ops_row
   WHERE product_code IS NOT NULL
   ORDER BY product_code
),
sales_latest AS (
  SELECT max(as_of) AS as_of
    FROM public.petstore_sku_sales_dna
   WHERE store_code = '63350001'
),
sales AS (
  SELECT s.product_code,
         s.qty_180::numeric AS qty_180,
         CASE WHEN s.cur_stock::numeric < 0 THEN NULL ELSE s.cur_stock::numeric END AS cur_stock
    FROM public.petstore_sku_sales_dna s
    JOIN sales_latest l ON l.as_of = s.as_of
   WHERE s.store_code = '63350001'
),
shop_sum AS (
  SELECT product_code,
         sum(COALESCE(monthly_sales, 0)) AS total_sales,
         count(*) AS shop_count
    FROM public.v_selection_shop
   GROUP BY product_code
),
max_shop AS (
  SELECT DISTINCT ON (product_code)
         product_code,
         monthly_sales AS max_sales,
         shop AS max_shop
    FROM public.v_selection_shop
   ORDER BY product_code, monthly_sales DESC NULLS LAST, captured_at DESC NULLS LAST
),
valid_base AS (
  SELECT product_code, shop, price
    FROM public.v_selection_shop
   WHERE monthly_sales >= 3  -- 0915:月销1~2的店不算市场价(BK34 宠胖胖 29.90 月销2 带偏)
     AND COALESCE(is_first_price, false) = false
     AND price > 1
),
valid_median AS (
  SELECT product_code,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY price) AS med_price
    FROM valid_base
   GROUP BY product_code
),
valid_kept AS (
  SELECT b.product_code, b.shop, b.price
    FROM valid_base b
    JOIN valid_median m ON m.product_code = b.product_code
   WHERE b.price >= m.med_price * 0.6
),
eff_min AS (
  SELECT DISTINCT ON (product_code)
         product_code,
         price AS eff_min_price,
         shop AS eff_min_shop
    FROM valid_kept
   ORDER BY product_code, price ASC NULLS LAST, shop
),
raw_min AS (
  SELECT product_code,
         min(price) FILTER (WHERE price > 0) AS raw_min_price
    FROM public.v_selection_shop
   GROUP BY product_code
)
SELECT ss.product_code,
       o.our_name,
       o.spec_text,
       ss.total_sales,
       ss.shop_count,
       ms.max_sales,
       ms.max_shop,
       em.eff_min_price,
       em.eff_min_shop,
       rm.raw_min_price,
       o.our_store_price,
       o.our_mt_price,
       s.qty_180,
       s.cur_stock,
       round((s.qty_180 * 30 / 142), 1) AS monthly_demand
  FROM shop_sum ss
  LEFT JOIN ops o ON o.product_code = ss.product_code
  LEFT JOIN sales s ON s.product_code = ss.product_code
  LEFT JOIN max_shop ms ON ms.product_code = ss.product_code
  LEFT JOIN eff_min em ON em.product_code = ss.product_code
  LEFT JOIN raw_min rm ON rm.product_code = ss.product_code
 WHERE ss.total_sales > 10;  -- Damon 0915:超过10+销量的品
