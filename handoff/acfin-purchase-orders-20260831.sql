-- acfin PurchaseOrder backfill + order_line_items.product_id repair
-- Date: 2026-08-31
--
-- Run pattern:
--   1) ROLLBACK dry-run: BEGIN; \i handoff/acfin-purchase-orders-20260831.sql; ROLLBACK;
--   2) Commit:           BEGIN; \i handoff/acfin-purchase-orders-20260831.sql; COMMIT;
--
-- Required manual precheck against sample PO-40-CP-8/PO-40-CP-9:
--   ac.voucher has bo text and data jsonb; ac.voucher_line has voucher_id and data jsonb.
--   Existing PurchaseOrder srcId is stored at ac.voucher.data->>'srcId'.
-- If the sample stores these keys in different columns, stop and adjust this file before running.

CREATE TABLE IF NOT EXISTS ac.purchase_order_backfill_skips_20260831 (
  order_id integer PRIMARY KEY,
  order_no text,
  line_count integer,
  diff numeric(14,2),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_line_items_bak_20260831 AS
SELECT *
  FROM order_line_items
 WHERE product_id IS NULL;

CREATE TEMP TABLE tmp_po_redlist_20260831 (
  order_id integer PRIMARY KEY,
  order_no text NOT NULL,
  expected_diff numeric(14,2),
  reason text NOT NULL
) ON COMMIT DROP;

INSERT INTO tmp_po_redlist_20260831(order_id, order_no, expected_diff, reason) VALUES
  (1186, '40-CP-7', 521391.78, '单头 79 万 vs 行合计 27 万'),
  (19, '40-PBXCD-20260205', 233560.69, '差 8 倍'),
  (13, '42-PBTYF-20260104', 109164.00, '16 行 factory_subtotal 全空'),
  (1176, '48-LL-1', -75808.00, '行合计 > 单头'),
  (25, '34-PBTDP-20251229', -34932.00, '行 > 单头'),
  (69, '40-CL-9', -14385.56, '行约等于单头三倍'),
  (1228, '78-WP-1', 9122.88, 'USD 计价单，币种混算'),
  (71, '40-CL-11', -2219.42, '小额不符'),
  (308, '40-CP-2', 1716.00, '小额不符'),
  (11, '32-PBLSQ-20260115', 1560.00, '小额不符');

CREATE TEMP TABLE tmp_po_line_totals_20260831 AS
SELECT o.id AS order_id,
       COALESCE(o.order_no, o.contract_no, o.id::text) AS order_no,
       COUNT(li.id)::integer AS line_count,
       ROUND(COALESCE(SUM(li.factory_subtotal), 0)::numeric, 2) AS line_total,
       ROUND(COALESCE(o.factory_amount, 0)::numeric, 2) AS order_total,
       ROUND((COALESCE(o.factory_amount, 0) - COALESCE(SUM(li.factory_subtotal), 0))::numeric, 2) AS diff
  FROM orders o
  LEFT JOIN order_line_items li ON li.order_id = o.id
 WHERE o.deleted_at IS NULL
   AND COALESCE(o.factory_amount, 0) > 0
   AND o.factory_company_id IS NOT NULL
 GROUP BY o.id, o.order_no, o.contract_no, o.factory_amount;

CREATE TEMP TABLE tmp_po_existing_20260831 AS
SELECT (v.data->>'srcId')::integer AS order_id
  FROM ac.voucher v
 WHERE v.bo = 'PurchaseOrder'
   AND v.data ? 'srcId'
   AND (v.data->>'srcId') ~ '^[0-9]+$';

INSERT INTO ac.purchase_order_backfill_skips_20260831(order_id, order_no, line_count, diff, reason)
SELECT t.order_id, t.order_no, t.line_count, t.diff,
       CASE
         WHEN r.order_id IS NOT NULL THEN r.reason
         WHEN e.order_id IS NOT NULL THEN '已存在 PurchaseOrder，按 srcId 去重跳过'
         WHEN NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = o.factory_company_id) THEN 'vendorId 不存在于 companies'
         WHEN ABS(t.diff) > 0.05 THEN 'orders.factory_amount 与 order_line_items.factory_subtotal 合计不符'
         ELSE '未知跳过原因'
       END
  FROM tmp_po_line_totals_20260831 t
  JOIN orders o ON o.id = t.order_id
  LEFT JOIN tmp_po_redlist_20260831 r ON r.order_id = t.order_id
  LEFT JOIN tmp_po_existing_20260831 e ON e.order_id = t.order_id
 WHERE r.order_id IS NOT NULL
    OR e.order_id IS NOT NULL
    OR ABS(t.diff) > 0.05
    OR NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = o.factory_company_id)
ON CONFLICT (order_id) DO UPDATE SET
  order_no = EXCLUDED.order_no,
  line_count = EXCLUDED.line_count,
  diff = EXCLUDED.diff,
  reason = EXCLUDED.reason;

CREATE TEMP TABLE tmp_po_candidates_20260831 AS
SELECT o.id AS order_id,
       o.order_date,
       o.contract_no,
       o.factory_company_id,
       o.currency,
       t.line_count,
       t.order_total,
       t.line_total,
       t.diff
  FROM orders o
  JOIN tmp_po_line_totals_20260831 t ON t.order_id = o.id
 WHERE NOT EXISTS (SELECT 1 FROM tmp_po_existing_20260831 e WHERE e.order_id = o.id)
   AND NOT EXISTS (SELECT 1 FROM tmp_po_redlist_20260831 r WHERE r.order_id = o.id)
   AND EXISTS (SELECT 1 FROM companies c WHERE c.id = o.factory_company_id)
   AND ABS(t.diff) <= 0.05;

CREATE TEMP TABLE tmp_po_inserted_20260831 (
  voucher_id bigint,
  order_id integer PRIMARY KEY
) ON COMMIT DROP;

WITH inserted AS (
  INSERT INTO ac.voucher(bo, data, created_at, updated_at)
  SELECT 'PurchaseOrder',
         jsonb_build_object(
           'srcId', c.order_id,
           'bizDate', c.order_date,
           'bizTypeId', 1,
           'externalCode', c.contract_no,
           'vendorId', c.factory_company_id,
           'currencyId', c.currency,
           'exchangeRate', 1,
           'noteTypeEnum', '增值税专用发票',
           'source', 'forge-acfin-purchase-order-backfill-20260831',
           'lineCount', c.line_count,
           'amountInclTax', c.order_total,
           'lineAmountInclTax', c.line_total,
           'amountDiff', c.diff
         ),
         now(),
         now()
    FROM tmp_po_candidates_20260831 c
   ORDER BY c.order_id
  RETURNING id, (data->>'srcId')::integer AS order_id
)
INSERT INTO tmp_po_inserted_20260831(voucher_id, order_id)
SELECT id, order_id FROM inserted;

INSERT INTO ac.voucher_line(voucher_id, data, created_at, updated_at)
SELECT i.voucher_id,
       jsonb_build_object(
         'productId', li.product_id,
         'transUomId', 1,
         'transQty', li.qty_ctn,
         'baseUomId', 1,
         'baseQty', li.qty_ctn,
         'amountInclTax', li.factory_subtotal,
         'sourceLineId', li.id
       ),
       now(),
       now()
  FROM tmp_po_inserted_20260831 i
  JOIN order_line_items li ON li.order_id = i.order_id
 ORDER BY i.order_id, COALESCE(li.sort_order, 0), li.id;

CREATE TEMP TABLE tmp_product_pick_20260831 AS
WITH product_base AS (
  SELECT id AS product_id,
         NULLIF(BTRIM(sku), '') AS sku,
         NULLIF(BTRIM(product_name), '') AS product_name,
         NULLIF(BTRIM(factory_code), '') AS factory_code
    FROM products
   WHERE NULLIF(BTRIM(sku), '') IS NOT NULL
),
sku_stats AS (
  SELECT sku,
         COUNT(*) AS sku_count,
         COUNT(DISTINCT COALESCE(factory_code, '<null>')) AS factory_count,
         MIN(product_id) AS any_product_id
    FROM product_base
   GROUP BY sku
),
name_stats AS (
  SELECT sku, product_name,
         COUNT(*) AS name_count,
         MIN(product_id) AS product_id
    FROM product_base
   WHERE product_name IS NOT NULL
   GROUP BY sku, product_name
),
factory_one AS (
  SELECT sku, MIN(product_id) AS product_id
    FROM product_base
   GROUP BY sku
  HAVING COUNT(DISTINCT COALESCE(factory_code, '<null>')) = 1
)
SELECT li.id AS line_id,
       li.order_id,
       NULLIF(BTRIM(li.sku), '') AS sku,
       NULLIF(BTRIM(li.product_name), '') AS product_name,
       CASE
         WHEN ss.sku_count = 1 THEN 'A'
         WHEN ss.sku_count > 1 AND ns.name_count = 1 THEN 'B'
         WHEN ss.sku_count > 1 AND fo.product_id IS NOT NULL THEN 'C'
         WHEN ss.sku_count > 1 AND ns.name_count IS NULL THEN 'D'
         ELSE 'E'
       END AS class,
       CASE
         WHEN ss.sku_count = 1 THEN ss.any_product_id
         WHEN ss.sku_count > 1 AND ns.name_count = 1 THEN ns.product_id
         WHEN ss.sku_count > 1 AND fo.product_id IS NOT NULL THEN fo.product_id
         ELSE NULL
       END AS product_id
  FROM order_line_items li
  JOIN sku_stats ss ON ss.sku = NULLIF(BTRIM(li.sku), '')
  LEFT JOIN name_stats ns
    ON ns.sku = NULLIF(BTRIM(li.sku), '')
   AND ns.product_name = NULLIF(BTRIM(li.product_name), '')
  LEFT JOIN factory_one fo ON fo.sku = NULLIF(BTRIM(li.sku), '')
 WHERE li.product_id IS NULL
   AND NULLIF(BTRIM(li.sku), '') IS NOT NULL;

CREATE TEMP TABLE tmp_product_updated_20260831 AS
UPDATE order_line_items li
   SET product_id = p.product_id,
       updated_at = now()
  FROM tmp_product_pick_20260831 p
 WHERE li.id = p.line_id
   AND p.class IN ('A', 'B', 'C')
   AND p.product_id IS NOT NULL
RETURNING p.class, li.id AS line_id, li.order_id, li.sku, li.product_name, li.product_id;

SELECT 'po_candidates' AS metric, COUNT(*)::text AS value FROM tmp_po_candidates_20260831
UNION ALL
SELECT 'po_inserted', COUNT(*)::text FROM tmp_po_inserted_20260831
UNION ALL
SELECT 'po_lines_inserted', COUNT(*)::text
  FROM ac.voucher_line vl
  JOIN tmp_po_inserted_20260831 i ON i.voucher_id = vl.voucher_id
UNION ALL
SELECT 'product_backfill_A', COUNT(*)::text FROM tmp_product_updated_20260831 WHERE class = 'A'
UNION ALL
SELECT 'product_backfill_B', COUNT(*)::text FROM tmp_product_updated_20260831 WHERE class = 'B'
UNION ALL
SELECT 'product_backfill_C', COUNT(*)::text FROM tmp_product_updated_20260831 WHERE class = 'C';

SELECT v.bo, COUNT(*)::integer AS voucher_count
  FROM ac.voucher v
 WHERE v.bo = 'PurchaseOrder'
 GROUP BY v.bo;

SELECT (v.data->>'srcId')::integer AS order_id,
       v.data->>'externalCode' AS external_code,
       ROUND((v.data->>'amountInclTax')::numeric, 2) AS order_amount,
       ROUND(SUM((vl.data->>'amountInclTax')::numeric), 2) AS line_amount,
       ROUND(ROUND((v.data->>'amountInclTax')::numeric, 2) - ROUND(SUM((vl.data->>'amountInclTax')::numeric), 2), 2) AS diff
  FROM ac.voucher v
  JOIN ac.voucher_line vl ON vl.voucher_id = v.id
 WHERE v.bo = 'PurchaseOrder'
 GROUP BY v.id, v.data
HAVING ABS(ROUND((v.data->>'amountInclTax')::numeric, 2) - ROUND(SUM((vl.data->>'amountInclTax')::numeric), 2)) > 0.00
 ORDER BY ABS(ROUND((v.data->>'amountInclTax')::numeric, 2) - ROUND(SUM((vl.data->>'amountInclTax')::numeric), 2)) DESC;

SELECT r.order_id, r.order_no, s.line_count, s.diff, r.reason,
       CASE WHEN v.id IS NULL THEN 'not_created' ELSE 'ERROR_CREATED' END AS status
  FROM tmp_po_redlist_20260831 r
  LEFT JOIN tmp_po_line_totals_20260831 s ON s.order_id = r.order_id
  LEFT JOIN ac.voucher v
    ON v.bo = 'PurchaseOrder'
   AND v.data->>'srcId' = r.order_id::text
 ORDER BY r.order_id;

SELECT class, order_id, sku, product_name, COUNT(*)::integer AS line_count
  FROM tmp_product_pick_20260831
 WHERE class IN ('D', 'E')
 GROUP BY class, order_id, sku, product_name
 ORDER BY class, order_id, sku, product_name;
