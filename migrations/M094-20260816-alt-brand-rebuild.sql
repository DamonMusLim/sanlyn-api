CREATE OR REPLACE VIEW petstore_market_alt_brands AS
WITH product_src AS (
  SELECT
    pei.external_product_code AS product_code,
    COALESCE(pm.standard_product_name, pm.pos_product_name) AS product_name,
    COALESCE(pm.standard_spec, pm.pos_spec) AS spec_text,
    pm.brand,
    pm.pos_brand,
    pm.out_price,
    concat_ws(
      ' ',
      pm.standard_product_name,
      pm.pos_product_name,
      pm.brand,
      pm.pos_brand,
      pm.standard_spec,
      pm.pos_spec
    ) AS search_text
  FROM product_master pm
  JOIN product_external_ids pei
    ON pei.product_id = pm.product_id
   AND pei.source_system = 'jelly_orange'
   AND pei.is_current
),
product_clean AS (
  SELECT
    p.*,
    trim(regexp_replace(regexp_replace(COALESCE(p.product_name, ''), '^(临期特惠|特价|清仓)\s*', ''), '^((【[^】]*】|\[[^]]*\]|（[^）]*）|\([^)]*\))\s*)+', '')) AS clean_name,
    regexp_match(
      COALESCE(p.spec_text, '') || ' ' || COALESCE(p.search_text, ''),
      '([0-9]+(?:\.[0-9]+)?)\s*(kg|KG|Kg|千克|公斤|g|G|克|mg|MG|Mg|ml|ML|Ml|mI|毫升|l|L|升)\s*[*xX×]\s*([0-9]+(?:\.[0-9]+)?)\s*(支|片|袋|盒|罐|粒|包|条|个)'
    ) AS qty_after_count,
    regexp_match(
      COALESCE(p.spec_text, '') || ' ' || COALESCE(p.search_text, ''),
      '([0-9]+(?:\.[0-9]+)?)\s*(支|片|袋|盒|罐|粒|包|条|个)\s*[*xX×]\s*([0-9]+(?:\.[0-9]+)?)\s*(kg|KG|Kg|千克|公斤|g|G|克|mg|MG|Mg|ml|ML|Ml|mI|毫升|l|L|升)'
    ) AS count_before_qty,
    regexp_match(
      COALESCE(p.spec_text, '') || ' ' || COALESCE(p.search_text, ''),
      '([0-9]+(?:\.[0-9]+)?)\s*(kg|KG|Kg|千克|公斤|g|G|克|mg|MG|Mg|ml|ML|Ml|mI|毫升|l|L|升)'
    ) AS single_qty
  FROM product_src p
),
product_parsed AS (
  SELECT
    p.product_code,
    p.out_price,
    CASE
      WHEN NULLIF(trim(COALESCE(p.brand, '')), '') IS NOT NULL THEN trim(p.brand)
      WHEN NULLIF(trim(COALESCE(p.pos_brand, '')), '') IS NOT NULL THEN trim(p.pos_brand)
      WHEN length(split_part(p.clean_name, ' ', 1)) <= 8 THEN NULLIF(split_part(p.clean_name, ' ', 1), '')
      WHEN split_part(p.clean_name, ' ', 1) ~ '^[A-Za-z]{4,}' THEN substring(split_part(p.clean_name, ' ', 1) from '^[A-Za-z]{4,}')
      WHEN split_part(p.clean_name, ' ', 1) ~ '^[一-龥]{2,}' THEN substring(substring(split_part(p.clean_name, ' ', 1) from '^[一-龥]+') from 1 for 6)
      ELSE NULL
    END AS our_brand,
    CASE
      WHEN p.count_before_qty IS NOT NULL THEN (p.count_before_qty)[1]::integer
      WHEN p.qty_after_count IS NOT NULL THEN (p.qty_after_count)[3]::integer
      ELSE 1
    END AS unit_count,
    CASE
      WHEN p.count_before_qty IS NOT NULL THEN
        CASE
          WHEN (p.count_before_qty)[4] IN ('kg','KG','Kg','千克','公斤') THEN (p.count_before_qty)[3]::numeric * 1000
          WHEN (p.count_before_qty)[4] IN ('mg','MG','Mg') THEN (p.count_before_qty)[3]::numeric / 1000
          WHEN (p.count_before_qty)[4] IN ('l','L','升') THEN (p.count_before_qty)[3]::numeric * 1000
          ELSE (p.count_before_qty)[3]::numeric
        END * (p.count_before_qty)[1]::numeric
      WHEN p.qty_after_count IS NOT NULL THEN
        CASE
          WHEN (p.qty_after_count)[2] IN ('kg','KG','Kg','千克','公斤') THEN (p.qty_after_count)[1]::numeric * 1000
          WHEN (p.qty_after_count)[2] IN ('mg','MG','Mg') THEN (p.qty_after_count)[1]::numeric / 1000
          WHEN (p.qty_after_count)[2] IN ('l','L','升') THEN (p.qty_after_count)[1]::numeric * 1000
          ELSE (p.qty_after_count)[1]::numeric
        END * (p.qty_after_count)[3]::numeric
      WHEN p.single_qty IS NOT NULL THEN
        CASE
          WHEN (p.single_qty)[2] IN ('kg','KG','Kg','千克','公斤') THEN (p.single_qty)[1]::numeric * 1000
          WHEN (p.single_qty)[2] IN ('mg','MG','Mg') THEN (p.single_qty)[1]::numeric / 1000
          WHEN (p.single_qty)[2] IN ('l','L','升') THEN (p.single_qty)[1]::numeric * 1000
          ELSE (p.single_qty)[1]::numeric
        END
      ELSE NULL
    END AS qty_g
  FROM product_clean p
),
product_rows AS (
  SELECT *
  FROM product_parsed
  WHERE qty_g IS NOT NULL
    AND unit_count IS NOT NULL
    AND our_brand IS NOT NULL
    AND our_brand NOT IN ('临期特惠','特价','清仓','试吃装','宠物','猫咪','狗狗','全价','进口','猫用','犬用','狗用','成猫','幼猫','成犬','幼犬','老年','体重','适合','通用','专用','主粮','猫粮','狗粮','零食','罐头','湿粮','驱虫','滴剂','内外','同驱','体内','体外','新品','包邮','正品','现货','直邮','旗舰')
),
raw_alt AS (
  SELECT
    r.id AS raw_id,
    r.competitor_name,
    r.title,
    r.price,
    r.qty_g,
    r.parsed_brand,
    r.parsed_unit_count,
    r.captured_at
  FROM petstore_market_quotes_raw r
  WHERE r.match_status IN ('NO_OUR_SKU','AMBIGUOUS_MULTI','NO_BRAND')
    AND r.qty_g IS NOT NULL
    AND r.parsed_brand IS NOT NULL
),
joined AS (
  SELECT
    p.product_code AS our_product_code,
    p.our_brand,
    p.out_price::numeric AS our_price,   -- Claude 改：旧视图该列是无精度 numeric，源列是 numeric(12,2)，CREATE OR REPLACE 不许改类型
    r.parsed_brand AS alt_brand,
    r.title AS alt_title,
    r.competitor_name AS alt_store,
    r.price AS alt_price,
    r.qty_g AS alt_qty_g,
    r.parsed_unit_count::numeric AS alt_unit_count,  -- Claude 改：同上，旧视图该列为 numeric
    EXISTS (
      SELECT 1
      FROM product_rows carried
      WHERE carried.our_brand = r.parsed_brand
    ) AS we_carry_brand,
    EXISTS (
      SELECT 1
      FROM product_rows same_spec
      WHERE same_spec.our_brand = r.parsed_brand
        AND same_spec.qty_g = r.qty_g
        AND same_spec.unit_count = r.parsed_unit_count
    ) AS we_carry_same_spec,
    r.captured_at,
    r.raw_id
  FROM raw_alt r
  JOIN product_rows p
    ON p.qty_g = r.qty_g
   AND p.unit_count = r.parsed_unit_count
   AND p.our_brand <> r.parsed_brand
)
SELECT DISTINCT ON (our_product_code, alt_brand, alt_store)
  our_product_code,
  our_brand,
  our_price,
  alt_brand,
  alt_title,
  alt_store,
  alt_price,
  alt_qty_g,
  alt_unit_count,
  we_carry_brand,
  we_carry_same_spec,
  captured_at
FROM joined
ORDER BY our_product_code, alt_brand, alt_store, captured_at DESC NULLS LAST, alt_price ASC NULLS LAST, raw_id DESC;

COMMENT ON VIEW petstore_market_alt_brands IS
  '其他品牌参考分析。our_brand 在 SQL 中近似复用 petstore-quote-parse.mjs 口径：去促销前缀、去开头括号、取首个空白前 token；token 超过 8 字时只取开头连续英文串(>=4)或开头连续中文串(最多6字)。';
