-- backfill-order-snapshots.sql
-- =====================================================================
--                  ⚠️  DO NOT RUN ON PROD WITHOUT REVIEW  ⚠️
-- ---------------------------------------------------------------------
-- Required pre-flight before any execution:
--   1. Run on dev DB first.
--   2. pg_dump orders BEFORE running:
--        pg_dump -t orders sanlyn_dev > /tmp/orders-pre-backfill.sql
--   3. Manually inspect 5+ orders post-run via the verification block
--      at the bottom of this file.
--   4. Only after dev passes & user signs off → run on prod with the
--      same backup procedure.
--
-- Goal: backfill orders.raw->'products'[*].(factoryPrice|netWeight|
-- grossWeight|cbm|size) from the products master, ONLY when the
-- snapshot field is NULL/'null' AND the order item carries a sku that
-- joins to products.sku.
--
-- Idempotent: re-running a second time is a no-op because the
-- snapshot fields are now non-null.
--
-- Scope (audited 2026-05-11):
--   id=1142 order=48-4  (CP1578, CP1580) — 2 rows, factoryPrice
--   id=1152 order=48-5  (CP0902)         — 1 row,  factoryPrice
--   Orders 76 (40-LL-2) and 1138 (37-ZC-16) carry NO sku on items and
--   are intentionally NOT touched here (37-ZC-16 has size-variant
--   ambiguity that would yield wrong factory_price under name-match).
-- =====================================================================

BEGIN;

-- ---- Step 1: rebuild raw.products[] in-place via SKU join ------------
-- We unnest each products[] item, LEFT JOIN to products master on sku,
-- COALESCE the snapshot fields with master values, and rebuild the
-- array preserving original order.
WITH expanded AS (
  SELECT o.id,
         o.raw,
         t.ord,
         t.item,
         p.factory_price,
         p.net_weight,
         p.gross_weight,
         p.cbm,
         p.size AS pm_size
  FROM orders o,
       LATERAL jsonb_array_elements(o.raw->'products')
         WITH ORDINALITY AS t(item, ord)
  LEFT JOIN products p ON p.sku = t.item->>'sku'
  WHERE jsonb_array_length(o.raw->'products') > 0
),
patched AS (
  SELECT id, ord,
         -- Only fill if snapshot field is null/'null' AND master has a value.
         -- jsonb_strip_nulls is NOT used; we keep the original keys intact.
         CASE WHEN (item->>'factoryPrice' IS NULL OR item->>'factoryPrice'='null')
                   AND factory_price IS NOT NULL
              THEN jsonb_set(item, '{factoryPrice}', to_jsonb(factory_price))
              ELSE item END AS step1
  FROM expanded
),
patched2 AS (
  SELECT e.id, e.ord,
         CASE WHEN (p.step1->>'netWeight' IS NULL OR p.step1->>'netWeight'='null')
                   AND e.net_weight IS NOT NULL
              THEN jsonb_set(p.step1, '{netWeight}', to_jsonb(e.net_weight))
              ELSE p.step1 END AS step2,
         e.gross_weight, e.cbm, e.pm_size
  FROM patched p
  JOIN expanded e ON e.id = p.id AND e.ord = p.ord
),
patched3 AS (
  SELECT id, ord,
         CASE WHEN (step2->>'grossWeight' IS NULL OR step2->>'grossWeight'='null')
                   AND gross_weight IS NOT NULL
              THEN jsonb_set(step2, '{grossWeight}', to_jsonb(gross_weight))
              ELSE step2 END AS step3,
         cbm, pm_size
  FROM patched2
),
patched4 AS (
  SELECT id, ord,
         CASE WHEN (step3->>'cbm' IS NULL OR step3->>'cbm'='null')
                   AND cbm IS NOT NULL
              THEN jsonb_set(step3, '{cbm}', to_jsonb(cbm))
              ELSE step3 END AS step4,
         pm_size
  FROM patched3
),
patched_final AS (
  SELECT id, ord,
         CASE WHEN (step4->>'size' IS NULL OR step4->>'size'='null')
                   AND pm_size IS NOT NULL
              THEN jsonb_set(step4, '{size}', to_jsonb(pm_size))
              ELSE step4 END AS final_item
  FROM patched4
),
new_arrays AS (
  SELECT id,
         jsonb_agg(final_item ORDER BY ord) AS new_products
  FROM patched_final
  GROUP BY id
)
UPDATE orders o
SET raw = jsonb_set(o.raw, '{products}', n.new_products)
FROM new_arrays n
WHERE o.id = n.id
  -- Only touch orders that actually had a fillable gap, to keep
  -- updated_at clean for unaffected rows.
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(o.raw->'products') it
    LEFT JOIN products p2 ON p2.sku = it->>'sku'
    WHERE ((it->>'factoryPrice' IS NULL OR it->>'factoryPrice'='null') AND p2.factory_price IS NOT NULL)
       OR ((it->>'netWeight'    IS NULL OR it->>'netWeight'   ='null') AND p2.net_weight    IS NOT NULL)
       OR ((it->>'grossWeight'  IS NULL OR it->>'grossWeight' ='null') AND p2.gross_weight  IS NOT NULL)
       OR ((it->>'cbm'          IS NULL OR it->>'cbm'         ='null') AND p2.cbm           IS NOT NULL)
       OR ((it->>'size'         IS NULL OR it->>'size'        ='null') AND p2.size          IS NOT NULL)
  );

-- ---- Step 2: stop the transaction here so we can verify --------------
-- Comment out the ROLLBACK and uncomment COMMIT once the verification
-- block below looks right.
ROLLBACK;
-- COMMIT;

-- =====================================================================
-- VERIFICATION (run separately — read only)
-- =====================================================================

-- V1. Compare gap counts before vs after (run this after a real COMMIT).
WITH oi AS (
  SELECT o.id, item->>'sku' AS sku,
         item->>'factoryPrice' AS fp
  FROM orders o,
       LATERAL jsonb_array_elements(o.raw->'products') AS item
  WHERE jsonb_array_length(o.raw->'products') > 0
)
SELECT COUNT(*) FILTER (WHERE fp IS NULL OR fp='null') AS rows_missing_factory_price_after
FROM oi;

-- V2. Spot-check the two flagship orders.
SELECT o.id, o.order_no,
       i->>'sku' AS sku,
       i->>'factoryPrice' AS factory_price_after,
       i->>'netWeight'    AS net_weight_after,
       i->>'grossWeight'  AS gross_weight_after,
       i->>'cbm'          AS cbm_after
FROM orders o,
     LATERAL jsonb_array_elements(o.raw->'products') AS i
WHERE o.id IN (1142, 1152)
ORDER BY o.id;

-- Expected after COMMIT:
--   id=1142 CP1578 -> factory_price_after = 1.44
--   id=1142 CP1580 -> factory_price_after = 1.44 (other fields master is null, stays null)
--   id=1152 CP0902 -> factory_price_after = 5.28

-- V3. Confirm orders 76 / 1138 untouched (intentional skip).
SELECT id, order_no, jsonb_array_length(raw->'products') AS n,
       (SELECT COUNT(*) FROM jsonb_array_elements(raw->'products') it
         WHERE it->>'factoryPrice' IS NOT NULL AND it->>'factoryPrice' <> 'null') AS rows_with_fp
FROM orders WHERE id IN (76, 1138);

-- Expected: rows_with_fp stays 0 for both (no SKU on items → not touched).

-- =====================================================================
-- AFTER-PROD CHECKLIST
--   [ ] dev backup taken
--   [ ] script ran inside BEGIN; reviewed plan
--   [ ] flipped ROLLBACK -> COMMIT for real run
--   [ ] V1/V2/V3 verifications captured to /tmp
--   [ ] OrderCardV2 DEAL ECONOMICS shows non-zero on 48-5 in dev UI
--   [ ] same procedure repeated on prod with fresh backup
-- =====================================================================
