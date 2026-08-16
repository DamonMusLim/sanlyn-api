CREATE OR REPLACE VIEW petstore_market_alt_brands AS
WITH our_products AS (
  SELECT
    pei.external_product_code AS our_product_code,
    COALESCE(pm.brand, pm.pos_brand) AS our_brand,
    round(pm.out_price::numeric, 2) AS our_price,
    (
      CASE lower((regexp_match(COALESCE(pm.standard_spec, pm.pos_spec, pm.standard_product_name, pm.pos_product_name, ''), '([0-9]+(?:\.[0-9]+)?)\s*(kg|千克|公斤|g|克|mg|ml|毫升|l|升)', 'i'))[2])
        WHEN 'kg' THEN ((regexp_match(COALESCE(pm.standard_spec, pm.pos_spec, pm.standard_product_name, pm.pos_product_name, ''), '([0-9]+(?:\.[0-9]+)?)\s*(kg|千克|公斤|g|克|mg|ml|毫升|l|升)', 'i'))[1])::numeric * 1000
        WHEN '千克' THEN ((regexp_match(COALESCE(pm.standard_spec, pm.pos_spec, pm.standard_product_name, pm.pos_product_name, ''), '([0-9]+(?:\.[0-9]+)?)\s*(kg|千克|公斤|g|克|mg|ml|毫升|l|升)', 'i'))[1])::numeric * 1000
        WHEN '公斤' THEN ((regexp_match(COALESCE(pm.standard_spec, pm.pos_spec, pm.standard_product_name, pm.pos_product_name, ''), '([0-9]+(?:\.[0-9]+)?)\s*(kg|千克|公斤|g|克|mg|ml|毫升|l|升)', 'i'))[1])::numeric * 1000
        WHEN 'mg' THEN ((regexp_match(COALESCE(pm.standard_spec, pm.pos_spec, pm.standard_product_name, pm.pos_product_name, ''), '([0-9]+(?:\.[0-9]+)?)\s*(kg|千克|公斤|g|克|mg|ml|毫升|l|升)', 'i'))[1])::numeric / 1000
        WHEN 'l' THEN ((regexp_match(COALESCE(pm.standard_spec, pm.pos_spec, pm.standard_product_name, pm.pos_product_name, ''), '([0-9]+(?:\.[0-9]+)?)\s*(kg|千克|公斤|g|克|mg|ml|毫升|l|升)', 'i'))[1])::numeric * 1000
        ELSE ((regexp_match(COALESCE(pm.standard_spec, pm.pos_spec, pm.standard_product_name, pm.pos_product_name, ''), '([0-9]+(?:\.[0-9]+)?)\s*(kg|千克|公斤|g|克|mg|ml|毫升|l|升)', 'i'))[1])::numeric
      END
      *
      COALESCE(
        NULLIF((regexp_match(COALESCE(pm.standard_spec, pm.pos_spec, pm.standard_product_name, pm.pos_product_name, ''), '[*xX×]\s*([0-9]+(?:\.[0-9]+)?)\s*(支|片|袋|盒|罐|粒|包|条|个)'))[1], '')::numeric,
        1
      )
    ) AS qty_g
  FROM product_master pm
  JOIN product_external_ids pei
    ON pei.product_id = pm.product_id
   AND pei.source_system = 'jelly_orange'
   AND pei.is_current
),
alt_quotes AS (
  SELECT
    NULLIF(COALESCE(q.raw_payload->>'parsed_brand', q.raw_payload->>'brand', q.raw_payload->>'quote_brand'), '') AS alt_brand,
    q.title AS alt_title,
    q.competitor_name AS alt_store,
    q.price AS alt_price,
    q.qty_g AS alt_qty_g,
    COALESCE(NULLIF(COALESCE(q.raw_payload->>'parsed_unit_count', q.raw_payload->>'unit_count'), '')::numeric, 1) AS alt_unit_count,
    q.captured_at
  FROM petstore_market_quotes_raw q
  WHERE q.match_status IN ('NO_OUR_SKU', 'AMBIGUOUS_MULTI')
    AND q.qty_g IS NOT NULL
)
SELECT
  op.our_product_code,
  op.our_brand,
  op.our_price,
  aq.alt_brand,
  aq.alt_title,
  aq.alt_store,
  aq.alt_price,
  aq.alt_qty_g,
  aq.alt_unit_count,
  EXISTS (
    SELECT 1
    FROM our_products carried
    WHERE carried.our_brand IS NOT DISTINCT FROM aq.alt_brand
  ) AS we_carry_brand,
  EXISTS (
    SELECT 1
    FROM our_products carried
    WHERE carried.our_brand IS NOT DISTINCT FROM aq.alt_brand
      AND carried.qty_g = aq.alt_qty_g
  ) AS we_carry_same_spec,
  aq.captured_at
FROM alt_quotes aq
JOIN our_products op
  ON op.qty_g = aq.alt_qty_g
WHERE aq.alt_brand IS DISTINCT FROM op.our_brand;
