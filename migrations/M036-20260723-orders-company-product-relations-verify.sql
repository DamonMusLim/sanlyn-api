-- M036 verification and unresolved report SQL.
-- Run after dry-run output review, or after a human-approved apply.

SELECT 'orders coverage' AS report,
       count(*) AS orders_total,
       count(seller_company_id) AS seller_company_id_filled,
       count(buyer_company_id) AS buyer_company_id_filled,
       count(customer_company_id) AS customer_company_id_filled,
       count(issuing_company_id) AS issuing_company_id_filled,
       count(operating_company_id) AS operating_company_id_filled,
       count(owner_company_id) AS owner_company_id_filled,
       count(factory_company_id) AS factory_company_id_filled,
       count(supplier_company_id) AS supplier_company_id_filled,
       count(trader_company_id) AS trader_company_id_filled
FROM orders
WHERE COALESCE(status, '') <> 'cancelled';

SELECT 'existing values preserved check' AS report,
       'Run the dry-run in one transaction and compare this against a pre-dump/audit table before apply' AS note;

SELECT 'factory_code must not be BABI' AS report,
       count(*) AS bad_rows
FROM orders
WHERE upper(COALESCE(factory_code, '')) = 'BABI';

SELECT 'trader hop rows' AS report,
       o.order_no,
       o.company_code AS buyer_code,
       s.code AS supplier_code,
       o.supplier_role_at_hop,
       t.code AS trader_code,
       f.code AS factory_code_by_id,
       o.factory_code AS factory_code_snapshot
FROM orders o
LEFT JOIN companies s ON s.id = o.supplier_company_id
LEFT JOIN companies t ON t.id = o.trader_company_id
LEFT JOIN companies f ON f.id = o.factory_company_id
WHERE o.supplier_role_at_hop = 'trader'
ORDER BY o.order_no;

SELECT 'unresolved orders' AS report,
       o.order_no,
       o.company_code,
       o.seller_code,
       o.issuing_company,
       o.factory_code,
       concat_ws('; ',
         CASE WHEN o.seller_company_id IS NULL THEN 'seller_company_id unresolved' END,
         CASE WHEN o.buyer_company_id IS NULL THEN 'buyer_company_id unresolved from company_code' END,
         CASE WHEN o.customer_company_id IS NULL THEN 'customer_company_id unresolved from company_code' END,
         CASE WHEN o.issuing_company_id IS NULL THEN 'issuing_company_id unresolved' END,
         CASE WHEN o.operating_company_id IS NULL THEN 'operating_company_id no reliable source' END,
         CASE WHEN o.owner_company_id IS NULL THEN 'owner_company_id no reliable source' END,
         CASE WHEN o.factory_company_id IS NULL THEN 'factory_company_id unresolved from factory_code' END,
         CASE WHEN o.supplier_company_id IS NULL THEN 'supplier_company_id ambiguous or missing partner_relationships' END
       ) AS unresolved_reason
FROM orders o
WHERE COALESCE(o.status, '') <> 'cancelled'
  AND (
    o.seller_company_id IS NULL OR o.buyer_company_id IS NULL OR o.customer_company_id IS NULL
    OR o.issuing_company_id IS NULL OR o.operating_company_id IS NULL OR o.owner_company_id IS NULL
    OR o.factory_company_id IS NULL OR o.supplier_company_id IS NULL
  )
ORDER BY o.order_no;

SELECT 'field_relations M036 count' AS report,
       count(*) AS active_m036_relations
FROM field_relations
WHERE status = 'active'
  AND relation_key IN (
    'orders.seller_company_id__companies.id',
    'orders.buyer_company_id__companies.id',
    'orders.customer_company_id__companies.id',
    'orders.issuing_company_id__companies.id',
    'orders.operating_company_id__companies.id',
    'orders.owner_company_id__companies.id',
    'orders.factory_company_id__companies.id',
    'orders.supplier_company_id__companies.id',
    'orders.trader_company_id__companies.id',
    'orders.id__order_line_items.order_id',
    'order_line_items.product_id__products.id',
    'order_line_items.sku__products.sku'
  );

SELECT 'field_lookups M036 count' AS report,
       count(*) AS active_snapshot_lookups
FROM field_lookups
WHERE status = 'active'
  AND mode = 'snapshot'
  AND lookup_key LIKE 'orders.%';

SELECT 'field definition drift: real columns missing catalog' AS report,
       c.table_name,
       c.column_name
FROM information_schema.columns c
LEFT JOIN field_definitions fd
  ON fd.module_key = c.table_name
 AND fd.field_key = c.column_name
 AND COALESCE(fd.status, 'active') = 'active'
WHERE c.table_schema = 'public'
  AND c.table_name IN ('orders', 'order_line_items', 'products')
  AND fd.field_key IS NULL
ORDER BY c.table_name, c.ordinal_position;

SELECT 'field definition drift: ghost catalog fields' AS report,
       fd.module_key,
       fd.field_key,
       fd.status
FROM field_definitions fd
LEFT JOIN information_schema.columns c
  ON c.table_schema = 'public'
 AND c.table_name = fd.module_key
 AND c.column_name = fd.field_key
WHERE fd.module_key IN ('orders', 'order_line_items', 'products')
  AND c.column_name IS NULL
  AND COALESCE(fd.status, 'active') = 'active'
ORDER BY fd.module_key, fd.field_key;

SELECT 'M1b customers missing from companies or tax_id' AS report,
       cu.company_code,
       cu.name_cn,
       cu.name_en,
       cu.role_type,
       c.id AS company_id,
       c.tax_id,
       CASE
         WHEN c.id IS NULL THEN 'absent from companies; classify real entity vs department/portal identity'
         WHEN NULLIF(btrim(c.tax_id), '') IS NULL THEN 'company exists but tax_id missing'
       END AS action_needed
FROM customers cu
LEFT JOIN companies c ON c.code = cu.company_code
WHERE c.id IS NULL OR NULLIF(btrim(c.tax_id), '') IS NULL
ORDER BY cu.company_code;

SELECT 'M5 OLI product_id gaps' AS report,
       oli.order_id,
       o.order_no,
       oli.sku,
       count(*) AS line_count
FROM order_line_items oli
LEFT JOIN orders o ON o.id = oli.order_id
WHERE oli.product_id IS NULL
GROUP BY oli.order_id, o.order_no, oli.sku
ORDER BY o.order_no, oli.sku;

SELECT 'M5 duplicate SKU ambiguity' AS report,
       sku,
       count(*) AS product_rows
FROM products
WHERE NULLIF(btrim(sku), '') IS NOT NULL
GROUP BY sku
HAVING count(*) > 1
ORDER BY count(*) DESC, sku;
