CREATE OR REPLACE VIEW public.v_rival_opportunity AS
WITH q0 AS (
  SELECT q.id,
         CASE
           WHEN q.shop_name LIKE '%爪壮壮%' THEN '爪壮壮'
           WHEN q.shop_name LIKE '%邻小虎%' THEN '邻小虎'
           ELSE q.shop_name
         END AS shop,
         q.product_name,
         q.month_sale,
         q.tier_price AS hand_price,
         q.list_price,
         q.tier_type,
         q.captured_at,
         row_number() OVER (
           PARTITION BY
             CASE
               WHEN q.shop_name LIKE '%爪壮壮%' THEN '爪壮壮'
               WHEN q.shop_name LIKE '%邻小虎%' THEN '邻小虎'
               ELSE q.shop_name
             END,
             q.product_name
           ORDER BY q.captured_at DESC NULLS LAST, q.id DESC
         ) AS rn
    FROM public.petstore_rival_quotes_app q
),
q AS (
  SELECT * FROM q0 WHERE rn = 1
),
m0 AS (
  SELECT m.*,
         row_number() OVER (
           PARTITION BY m.quote_id
           ORDER BY m.matched_at DESC NULLS LAST
         ) AS rn
    FROM public.petstore_rival_app_match m
),
m AS (
  SELECT * FROM m0 WHERE rn = 1
),
v0 AS (
  SELECT v.*,
         row_number() OVER (
           PARTITION BY v.shop, v.product_name
           ORDER BY v.captured_at DESC NULLS LAST
         ) AS rn
    FROM public.v_rival_sku_today v
),
v AS (
  SELECT * FROM v0 WHERE rn = 1
),
dna_asof AS (
  SELECT max(as_of) AS as_of
    FROM public.petstore_sku_sales_dna
   WHERE store_code = '63350001'
),
dna AS (
  SELECT d.*
    FROM public.petstore_sku_sales_dna d
    JOIN dna_asof a ON a.as_of = d.as_of
   WHERE d.store_code = '63350001'
),
base AS (
  SELECT q.shop,
         q.product_name,
         COALESCE(v.month_sale, q.month_sale) AS month_sale,
         COALESCE(v.hand_price, q.hand_price) AS hand_price,
         COALESCE(v.tier_type, q.tier_type) AS tier_type,
         v.tier_text,
         v.category,
         COALESCE(v.is_med, false) AS is_med,
         COALESCE(v.captured_at, q.captured_at) AS captured_at,
         m.match_status,
         CASE WHEN m.match_status = 'MATCHED' THEN m.product_code ELSE NULL END AS product_code,
         CASE
           WHEN m.match_status = 'MATCHED' AND COALESCE(m.match_rule, '') LIKE '%+llm_same%' THEN 'high'
           WHEN m.match_status = 'AMBIGUOUS_MULTI' OR COALESCE(m.match_rule, '') LIKE 'LLM_UNSURE:%' THEN 'low'
           ELSE 'none'
         END AS confidence,
         CASE
           WHEN m.match_status = 'MATCHED' AND (dna.product_code IS NULL OR dna.cur_stock IS NULL) THEN 'matched_no_dna'
           WHEN m.match_status = 'MATCHED' AND dna.cur_stock > 0 THEN 'on_sale_in_stock'
           WHEN m.match_status = 'MATCHED' AND dna.cur_stock <= 0 THEN 'on_sale_out_of_stock'
           WHEN m.match_status = 'NO_OUR_SKU' THEN 'not_carried'
           ELSE 'unknown'
         END AS our_status,
         CASE WHEN m.match_status = 'MATCHED' THEN dna.qty_90 ELSE NULL END AS our_qty_90,
         CASE WHEN m.match_status = 'MATCHED' THEN dna.qty_180 ELSE NULL END AS our_qty_180,
         CASE WHEN m.match_status = 'MATCHED' THEN dna.cur_stock ELSE NULL END AS our_cur_stock,
         COALESCE(v.hand_price, q.hand_price) <= 1 AS is_hook,
         COALESCE(v.tier_type, q.tier_type) IN ('first_n', 'first_n_each') AS is_first_price
    FROM q
    LEFT JOIN m ON m.quote_id = q.id
    LEFT JOIN v ON v.shop = q.shop AND v.product_name = q.product_name
    LEFT JOIN dna ON dna.product_code = m.product_code
),
typed AS (
  SELECT b.*,
         CASE
           WHEN b.our_status = 'on_sale_out_of_stock' THEN 'restock'
           WHEN b.our_status = 'not_carried' THEN 'new_item'
           WHEN b.confidence = 'low' OR b.our_status = 'unknown' THEN 'review'
           ELSE 'watch'
         END AS opp_type
    FROM base b
),
eligible AS (
  SELECT *
    FROM typed
   WHERE month_sale >= 20
      OR opp_type = 'restock'
)
SELECT e.*,
       row_number() OVER (
         PARTITION BY e.opp_type
         ORDER BY
           CASE WHEN e.is_hook THEN 1 ELSE 0 END,
           e.month_sale DESC NULLS LAST
       ) AS rank_in_type
  FROM eligible e;
