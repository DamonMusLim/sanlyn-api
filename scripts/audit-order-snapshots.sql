-- audit-order-snapshots.sql
-- =====================================================================
-- READ-ONLY audit of orders.raw->'products' snapshot field gaps.
--
-- Background: PR #144 fixed addItem() so new orders carry
--   factoryPrice / netWeight / grossWeight / cbm / size on each item.
-- This script measures the bug-blast-radius on existing rows so we can
-- decide what's safe to backfill from the products master table.
--
-- Run on dev first via: mcp__sanlyn-pg__query (pool is read-only)
-- =====================================================================

-- ---- Q1: total population --------------------------------------------
-- How many orders have a non-empty products[] in raw?
SELECT COUNT(*) AS total_orders,
       SUM(CASE WHEN raw->'products' IS NOT NULL
                 AND jsonb_array_length(raw->'products') > 0
                THEN 1 ELSE 0 END) AS orders_with_products
FROM orders;

-- ---- Q2: gap summary -------------------------------------------------
-- Across all order line items, how many are missing each snapshot field?
WITH order_items AS (
  SELECT o.id,
         item->>'sku'           AS sku,
         item->>'factoryPrice'  AS snap_factory_price,
         item->>'netWeight'     AS snap_net_weight,
         item->>'grossWeight'   AS snap_gross_weight,
         item->>'cbm'           AS snap_cbm,
         item->>'size'          AS snap_size
  FROM orders o,
       LATERAL jsonb_array_elements(o.raw->'products') AS item
  WHERE jsonb_array_length(o.raw->'products') > 0
)
SELECT COUNT(DISTINCT id)                                                AS affected_orders,
       COUNT(*)                                                          AS affected_rows,
       SUM((snap_factory_price IS NULL OR snap_factory_price='null')::int) AS missing_factory_price,
       SUM((snap_net_weight    IS NULL OR snap_net_weight   ='null')::int) AS missing_net_weight,
       SUM((snap_gross_weight  IS NULL OR snap_gross_weight ='null')::int) AS missing_gross_weight,
       SUM((snap_cbm           IS NULL OR snap_cbm          ='null')::int) AS missing_cbm,
       SUM((snap_size          IS NULL OR snap_size         ='null')::int) AS missing_size
FROM order_items
WHERE snap_factory_price IS NULL OR snap_factory_price='null'
   OR snap_net_weight    IS NULL OR snap_net_weight   ='null'
   OR snap_gross_weight  IS NULL OR snap_gross_weight ='null'
   OR snap_cbm           IS NULL OR snap_cbm          ='null';

-- ---- Q3: per-order detail with master-table coverage -----------------
-- For each affected line: is there a products row keyed by SKU we can
-- read the canonical value from?
WITH order_items AS (
  SELECT o.id, o.order_no,
         item->>'sku'          AS sku,
         item->>'factoryPrice' AS snap_factory_price,
         item->>'netWeight'    AS snap_net_weight,
         item->>'grossWeight'  AS snap_gross_weight,
         item->>'cbm'          AS snap_cbm
  FROM orders o,
       LATERAL jsonb_array_elements(o.raw->'products') AS item
  WHERE jsonb_array_length(o.raw->'products') > 0
)
SELECT oi.id, oi.order_no, oi.sku,
       (oi.snap_factory_price IS NULL OR oi.snap_factory_price='null') AS miss_fp,
       (oi.snap_net_weight    IS NULL OR oi.snap_net_weight   ='null') AS miss_nw,
       (oi.snap_gross_weight  IS NULL OR oi.snap_gross_weight ='null') AS miss_gw,
       (oi.snap_cbm           IS NULL OR oi.snap_cbm          ='null') AS miss_cbm,
       p.factory_price AS pm_fp,
       p.net_weight    AS pm_nw,
       p.gross_weight  AS pm_gw,
       p.cbm           AS pm_cbm
FROM order_items oi
LEFT JOIN products p ON p.sku = oi.sku
WHERE oi.snap_factory_price IS NULL OR oi.snap_factory_price='null'
   OR oi.snap_net_weight    IS NULL OR oi.snap_net_weight   ='null'
   OR oi.snap_gross_weight  IS NULL OR oi.snap_gross_weight ='null'
   OR oi.snap_cbm           IS NULL OR oi.snap_cbm          ='null'
ORDER BY oi.id, oi.sku;

-- ---- Q4: targeted check on order 48-5 / CP0902 -----------------------
-- This is the ticket's flagship example; confirm the gap & master value.
SELECT o.id, o.order_no,
       i->>'sku' AS sku,
       i->>'factoryPrice' AS snap_fp,
       p.factory_price    AS pm_fp,
       i->>'netWeight' AS snap_nw,
       p.net_weight    AS pm_nw
FROM orders o,
     LATERAL jsonb_array_elements(o.raw->'products') AS i
LEFT JOIN products p ON p.sku = i->>'sku'
WHERE o.id = 1152;

-- =====================================================================
-- SUMMARY (captured 2026-05-11 against current dev pool):
--   - 4 orders / 53 line rows have at least one missing snapshot field.
--   - 2 orders carry items WITH SKU and master-table coverage (safe to
--     backfill via UPDATE...FROM products):
--       id=1142 order=48-4  (CP1578, CP1580)   -> 2 rows, factoryPrice
--       id=1152 order=48-5  (CP0902)           -> 1 row,  factoryPrice
--   - 2 orders carry items WITHOUT SKU (cannot resolve canonically):
--       id=76   order=40-LL-2  (7 items, name-match works 7/7 but
--                               size variant is unique so it is safe;
--                               still flagged for human review)
--       id=1138 order=37-ZC-16 (43 items; product_name maps to ONE
--                               master SKU across multiple sizes
--                               500G/1.5KG/8KG/50G -> name-match would
--                               pull WRONG factory_price for non-default
--                               sizes; DO NOT auto-backfill)
-- =====================================================================
