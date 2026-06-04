-- Unified field catalog MVP: canonical metadata + additive binding link.
-- Human-applied migration/seed. Idempotent and read-only to business tables.

CREATE TABLE IF NOT EXISTS field_definitions (
  canonical_key text PRIMARY KEY,
  module_key text NOT NULL,
  field_key text NOT NULL,
  label text NOT NULL,
  type text NOT NULL,
  unit text NULL,
  format jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_legal boolean NOT NULL DEFAULT false,
  grain text NOT NULL,
  relationship_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  validation_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (module_key, field_key),
  CONSTRAINT chk_field_definitions_canonical_key
    CHECK (canonical_key = module_key || '.' || field_key),
  CONSTRAINT chk_field_definitions_module_key
    CHECK (module_key IN ('orders', 'products', 'order_line_items', 'customs', 'shipping', 'finance')),
  CONSTRAINT chk_field_definitions_type
    CHECK (type IN ('number', 'integer', 'string', 'percent', 'currency', 'json', 'boolean', 'date', 'datetime')),
  CONSTRAINT chk_field_definitions_status
    CHECK (status IN ('active', 'inactive'))
);

CREATE INDEX IF NOT EXISTS idx_field_definitions_module_key
  ON field_definitions (module_key);

CREATE INDEX IF NOT EXISTS idx_field_definitions_status
  ON field_definitions (status);

CREATE INDEX IF NOT EXISTS idx_field_definitions_is_legal
  ON field_definitions (is_legal);

ALTER TABLE field_bindings
  ADD COLUMN IF NOT EXISTS canonical_key text;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_field_bindings_canonical_key'
  ) THEN
    ALTER TABLE field_bindings
      ADD CONSTRAINT fk_field_bindings_canonical_key
      FOREIGN KEY (canonical_key)
      REFERENCES field_definitions (canonical_key)
      NOT VALID;
  END IF;
END;
$migration$;

CREATE INDEX IF NOT EXISTS idx_field_bindings_canonical_key
  ON field_bindings (canonical_key);

CREATE INDEX IF NOT EXISTS idx_field_bindings_canonical_key_status
  ON field_bindings (canonical_key, status);

INSERT INTO field_definitions (
  canonical_key,
  module_key,
  field_key,
  label,
  type,
  unit,
  format,
  is_legal,
  grain,
  relationship_json,
  validation_json,
  status
)
VALUES
  (
    'order_line_items.line_cbm',
    'order_line_items',
    'line_cbm',
    'Line CBM',
    'number',
    'cbm',
    $json${"precision":3}$json$::jsonb,
    true,
    'line_item',
    $json${"kind":"derived","formula_role":"line_quantity_multiply","inputs":["per_carton_cbm","order_line_items.total_qty"]}$json$::jsonb,
    $json${"nullable":true,"min":0}$json$::jsonb,
    'active'
  ),
  (
    'order_line_items.line_net_weight',
    'order_line_items',
    'line_net_weight',
    'Line Net Weight',
    'number',
    'kg',
    $json${"precision":3}$json$::jsonb,
    true,
    'line_item',
    $json${"kind":"derived","formula_role":"line_quantity_multiply","inputs":["per_carton_net_weight","order_line_items.total_qty"]}$json$::jsonb,
    $json${"nullable":true,"min":0}$json$::jsonb,
    'active'
  ),
  (
    'order_line_items.line_gross_weight',
    'order_line_items',
    'line_gross_weight',
    'Line Gross Weight',
    'number',
    'kg',
    $json${"precision":3}$json$::jsonb,
    true,
    'line_item',
    $json${"kind":"derived","formula_role":"line_quantity_multiply","inputs":["per_carton_gross_weight","order_line_items.total_qty"]}$json$::jsonb,
    $json${"nullable":true,"min":0}$json$::jsonb,
    'active'
  ),
  (
    'order_line_items.total_qty',
    'order_line_items',
    'total_qty',
    'Total Quantity',
    'integer',
    'pcs',
    '{}'::jsonb,
    true,
    'line_item',
    $json${"kind":"input","formula_role":"line_quantity"}$json$::jsonb,
    $json${"nullable":true,"min":0,"integer":true}$json$::jsonb,
    'active'
  ),
  (
    'products.hs_code',
    'products',
    'hs_code',
    'HS Code',
    'string',
    NULL,
    '{}'::jsonb,
    true,
    'master_data',
    $json${"kind":"master_data","legacy_scope":"order_line_items","legacy_field_key":"hs_code"}$json$::jsonb,
    $json${"nullable":true,"maxLength":255}$json$::jsonb,
    'active'
  ),
  (
    'products.declaration_name',
    'products',
    'declaration_name',
    'Declaration Name',
    'string',
    NULL,
    '{}'::jsonb,
    true,
    'master_data',
    $json${"kind":"master_data","legacy_scope":"order_line_items","legacy_field_key":"declaration_name"}$json$::jsonb,
    $json${"nullable":true,"maxLength":255}$json$::jsonb,
    'active'
  ),
  (
    'products.declaration_elements',
    'products',
    'declaration_elements',
    'Declaration Elements',
    'json',
    NULL,
    '{}'::jsonb,
    true,
    'master_data',
    $json${"kind":"master_data","legacy_scope":"order_line_items","legacy_field_key":"declaration_elements"}$json$::jsonb,
    $json${"nullable":true}$json$::jsonb,
    'active'
  ),
  (
    'products.tax_rebate_rate',
    'products',
    'tax_rebate_rate',
    'Tax Rebate Rate',
    'percent',
    'percent',
    $json${"precision":4}$json$::jsonb,
    true,
    'master_data',
    $json${"kind":"master_data","legacy_scope":"order_line_items","legacy_field_key":"tax_rebate_rate"}$json$::jsonb,
    $json${"nullable":true,"min":0,"max":1}$json$::jsonb,
    'active'
  ),
  (
    'customs.total_cbm',
    'customs',
    'total_cbm',
    'Customs Total CBM',
    'number',
    'cbm',
    $json${"precision":3}$json$::jsonb,
    true,
    'customs_consolidated',
    $json${"kind":"aggregate","agg":"sum","source_canonical_key":"order_line_items.line_cbm","partition":"customs_consolidated"}$json$::jsonb,
    $json${"nullable":true,"min":0}$json$::jsonb,
    'active'
  ),
  (
    'customs.total_net_weight',
    'customs',
    'total_net_weight',
    'Customs Total Net Weight',
    'number',
    'kg',
    $json${"precision":3}$json$::jsonb,
    true,
    'customs_consolidated',
    $json${"kind":"aggregate","agg":"sum","source_canonical_key":"order_line_items.line_net_weight","partition":"customs_consolidated"}$json$::jsonb,
    $json${"nullable":true,"min":0}$json$::jsonb,
    'active'
  ),
  (
    'customs.total_gross_weight',
    'customs',
    'total_gross_weight',
    'Customs Total Gross Weight',
    'number',
    'kg',
    $json${"precision":3}$json$::jsonb,
    true,
    'customs_consolidated',
    $json${"kind":"aggregate","agg":"sum","source_canonical_key":"order_line_items.line_gross_weight","partition":"customs_consolidated"}$json$::jsonb,
    $json${"nullable":true,"min":0}$json$::jsonb,
    'active'
  ),
  (
    'orders.total_cbm',
    'orders',
    'total_cbm',
    'Order Total CBM',
    'number',
    'cbm',
    $json${"precision":3}$json$::jsonb,
    true,
    'order',
    $json${"kind":"aggregate","agg":"sum","source_canonical_key":"order_line_items.line_cbm","partition":"order"}$json$::jsonb,
    $json${"nullable":true,"min":0}$json$::jsonb,
    'active'
  ),
  (
    'orders.total_gross_weight',
    'orders',
    'total_gross_weight',
    'Order Total Gross Weight',
    'number',
    'kg',
    $json${"precision":3}$json$::jsonb,
    true,
    'order',
    $json${"kind":"aggregate","agg":"sum","source_canonical_key":"order_line_items.line_gross_weight","partition":"order"}$json$::jsonb,
    $json${"nullable":true,"min":0}$json$::jsonb,
    'active'
  ),
  (
    'orders.total_net_weight',
    'orders',
    'total_net_weight',
    'Order Total Net Weight',
    'number',
    'kg',
    $json${"precision":3}$json$::jsonb,
    true,
    'order',
    $json${"kind":"aggregate","agg":"sum","source_canonical_key":"order_line_items.line_net_weight","partition":"order"}$json$::jsonb,
    $json${"nullable":true,"min":0}$json$::jsonb,
    'active'
  )
ON CONFLICT (canonical_key) DO UPDATE SET
  module_key = EXCLUDED.module_key,
  field_key = EXCLUDED.field_key,
  label = EXCLUDED.label,
  type = EXCLUDED.type,
  unit = EXCLUDED.unit,
  format = EXCLUDED.format,
  is_legal = EXCLUDED.is_legal,
  grain = EXCLUDED.grain,
  relationship_json = EXCLUDED.relationship_json,
  validation_json = EXCLUDED.validation_json,
  status = EXCLUDED.status,
  updated_at = now();

UPDATE field_bindings fb
SET canonical_key = mapping.canonical_key
FROM (
  VALUES
    ('order_line_items', 'cbm', 'order_line_items.line_cbm'),
    ('order_line_items', 'net_weight', 'order_line_items.line_net_weight'),
    ('order_line_items', 'gross_weight', 'order_line_items.line_gross_weight'),
    ('order_line_items', 'total_qty', 'order_line_items.total_qty'),
    ('order_line_items', 'hs_code', 'products.hs_code'),
    ('order_line_items', 'declaration_name', 'products.declaration_name'),
    ('order_line_items', 'declaration_elements', 'products.declaration_elements'),
    ('order_line_items', 'tax_rebate_rate', 'products.tax_rebate_rate'),
    ('customs_consolidated', 'cbm', 'customs.total_cbm'),
    ('customs_consolidated', 'nw_kg', 'customs.total_net_weight'),
    ('customs_consolidated', 'gw_kg', 'customs.total_gross_weight'),
    ('orders', 'total_cbm', 'orders.total_cbm'),
    ('orders', 'total_gross_weight', 'orders.total_gross_weight'),
    ('orders', 'total_net_weight', 'orders.total_net_weight')
) AS mapping(scope, field_key, canonical_key)
WHERE fb.scope = mapping.scope
  AND fb.field_key = mapping.field_key;

SELECT
  (SELECT COUNT(*) FROM field_definitions WHERE canonical_key IN (
    'order_line_items.line_cbm',
    'order_line_items.line_net_weight',
    'order_line_items.line_gross_weight',
    'order_line_items.total_qty',
    'products.hs_code',
    'products.declaration_name',
    'products.declaration_elements',
    'products.tax_rebate_rate',
    'customs.total_cbm',
    'customs.total_net_weight',
    'customs.total_gross_weight',
    'orders.total_cbm',
    'orders.total_gross_weight',
    'orders.total_net_weight'
  )) AS canonical_definition_count,
  (SELECT COUNT(*) FROM field_definitions WHERE is_legal = true AND canonical_key IN (
    'order_line_items.line_cbm',
    'order_line_items.line_net_weight',
    'order_line_items.line_gross_weight',
    'order_line_items.total_qty',
    'products.hs_code',
    'products.declaration_name',
    'products.declaration_elements',
    'products.tax_rebate_rate',
    'customs.total_cbm',
    'customs.total_net_weight',
    'customs.total_gross_weight',
    'orders.total_cbm',
    'orders.total_gross_weight',
    'orders.total_net_weight'
  )) AS legal_definition_count,
  (SELECT COUNT(*) FROM field_bindings WHERE canonical_key IN (
    'order_line_items.line_cbm',
    'order_line_items.line_net_weight',
    'order_line_items.line_gross_weight',
    'order_line_items.total_qty',
    'products.hs_code',
    'products.declaration_name',
    'products.declaration_elements',
    'products.tax_rebate_rate',
    'customs.total_cbm',
    'customs.total_net_weight',
    'customs.total_gross_weight',
    'orders.total_cbm',
    'orders.total_gross_weight',
    'orders.total_net_weight'
  )) AS linked_binding_count;
