-- Field catalog slice 2: additive lookup metadata.
-- Human-applied migration/seed. Idempotent and read-only to business tables.

INSERT INTO field_lookups (
  lookup_key,
  module_key,
  target_field_key,
  relation_key,
  related_module,
  related_field_key,
  mode,
  is_readonly,
  status
)
VALUES
  (
    $lookup$order_line_items.hs_code__lookup__products.hs_code$lookup$,
    $module$order_line_items$module$,
    $field$hs_code$field$,
    $relation$order_line_items.sku__products.sku$relation$,
    $module$products$module$,
    $field$hs_code$field$,
    $mode$sync$mode$,
    true,
    $status$active$status$
  ),
  (
    $lookup$order_line_items.declaration_name__lookup__products.declaration_name$lookup$,
    $module$order_line_items$module$,
    $field$declaration_name$field$,
    $relation$order_line_items.sku__products.sku$relation$,
    $module$products$module$,
    $field$declaration_name$field$,
    $mode$sync$mode$,
    true,
    $status$active$status$
  ),
  (
    $lookup$order_line_items.declaration_elements__lookup__products.declaration_elements$lookup$,
    $module$order_line_items$module$,
    $field$declaration_elements$field$,
    $relation$order_line_items.sku__products.sku$relation$,
    $module$products$module$,
    $field$declaration_elements$field$,
    $mode$sync$mode$,
    true,
    $status$active$status$
  ),
  (
    $lookup$order_line_items.tax_rebate_rate__lookup__products.tax_rebate_rate$lookup$,
    $module$order_line_items$module$,
    $field$tax_rebate_rate$field$,
    $relation$order_line_items.sku__products.sku$relation$,
    $module$products$module$,
    $field$tax_rebate_rate$field$,
    $mode$sync$mode$,
    true,
    $status$active$status$
  )
ON CONFLICT (lookup_key) DO UPDATE SET
  module_key = EXCLUDED.module_key,
  target_field_key = EXCLUDED.target_field_key,
  relation_key = EXCLUDED.relation_key,
  related_module = EXCLUDED.related_module,
  related_field_key = EXCLUDED.related_field_key,
  mode = EXCLUDED.mode,
  is_readonly = EXCLUDED.is_readonly,
  status = EXCLUDED.status,
  updated_at = now();

SELECT
  lookup_key,
  module_key,
  target_field_key,
  relation_key,
  related_module,
  related_field_key,
  mode,
  is_readonly,
  status
FROM field_lookups
WHERE relation_key = $relation$order_line_items.sku__products.sku$relation$
ORDER BY lookup_key;
