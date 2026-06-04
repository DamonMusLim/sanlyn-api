-- Field catalog slice 1: additive metadata, relations, lookups DDL, raw introspection.
-- Human-applied migration/seed. Idempotent and read-only to business tables.

ALTER TABLE field_definitions
  DROP CONSTRAINT IF EXISTS chk_field_definitions_module_key;

ALTER TABLE field_definitions
  ADD CONSTRAINT chk_field_definitions_module_key
  CHECK (module_key IN (
    'orders',
    'products',
    'order_line_items',
    'customs',
    'shipping',
    'finance',
    'shipping_plans',
    'companies'
  ));

ALTER TABLE field_definitions
  ADD COLUMN IF NOT EXISTS source_kind text,
  ADD COLUMN IF NOT EXISTS source_table text,
  ADD COLUMN IF NOT EXISTS source_column text,
  ADD COLUMN IF NOT EXISTS is_system_derived boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_curated boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS customs_relevant boolean,
  ADD COLUMN IF NOT EXISTS stale_risk text NULL;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_field_definitions_source_kind'
  ) THEN
    ALTER TABLE field_definitions
      ADD CONSTRAINT chk_field_definitions_source_kind
      CHECK (source_kind IN ('raw_column', 'computed', 'lookup', 'constant'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_field_definitions_stale_risk'
  ) THEN
    ALTER TABLE field_definitions
      ADD CONSTRAINT chk_field_definitions_stale_risk
      CHECK (stale_risk IN ('low', 'medium', 'high') OR stale_risk IS NULL);
  END IF;
END;
$migration$;

UPDATE field_definitions
SET customs_relevant = is_legal
WHERE customs_relevant IS NULL;

UPDATE field_definitions
SET
  is_curated = true,
  customs_relevant = is_legal,
  source_kind = CASE
    WHEN canonical_key IN (
      'products.hs_code',
      'products.declaration_name',
      'products.declaration_elements',
      'products.tax_rebate_rate'
    ) THEN 'lookup'
    ELSE 'computed'
  END,
  is_system_derived = false,
  updated_at = now()
WHERE canonical_key IN (
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
);

CREATE TABLE IF NOT EXISTS field_relations (
  relation_key text PRIMARY KEY,
  from_module text NOT NULL,
  from_field_key text NOT NULL,
  to_module text NOT NULL,
  to_field_key text NOT NULL,
  relation_type text NOT NULL,
  role_key text NOT NULL,
  label text NOT NULL,
  cardinality text NOT NULL,
  resolution_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_field_relations_relation_type
    CHECK (relation_type IN ('fk', 'logical', 'subform')),
  CONSTRAINT chk_field_relations_cardinality
    CHECK (cardinality IN ('one_to_one', 'many_to_one', 'one_to_many', 'many_to_many')),
  CONSTRAINT chk_field_relations_status
    CHECK (status IN ('active', 'inactive'))
);

CREATE INDEX IF NOT EXISTS idx_field_relations_from_field
  ON field_relations (from_module, from_field_key);

CREATE INDEX IF NOT EXISTS idx_field_relations_to_field
  ON field_relations (to_module, to_field_key);

CREATE INDEX IF NOT EXISTS idx_field_relations_status
  ON field_relations (status);

CREATE TABLE IF NOT EXISTS field_lookups (
  lookup_key text PRIMARY KEY,
  module_key text NOT NULL,
  target_field_key text NOT NULL,
  relation_key text NOT NULL,
  related_module text NOT NULL,
  related_field_key text NOT NULL,
  mode text NOT NULL,
  is_readonly boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_field_lookups_mode
    CHECK (mode IN ('display_only', 'snapshot', 'sync')),
  CONSTRAINT chk_field_lookups_status
    CHECK (status IN ('active', 'inactive'))
);

CREATE INDEX IF NOT EXISTS idx_field_lookups_target_field
  ON field_lookups (module_key, target_field_key);

CREATE INDEX IF NOT EXISTS idx_field_lookups_relation_key
  ON field_lookups (relation_key);

CREATE INDEX IF NOT EXISTS idx_field_lookups_status
  ON field_lookups (status);

-- Slice 1 intentionally defers field_lookups seeds. Slice 2 will choose snapshot vs sync semantics.

INSERT INTO field_relations (
  relation_key,
  from_module,
  from_field_key,
  to_module,
  to_field_key,
  relation_type,
  role_key,
  label,
  cardinality,
  resolution_json,
  status
)
VALUES
  (
    'orders.buyer_company_id__companies.id',
    'orders',
    'buyer_company_id',
    'companies',
    'id',
    'fk',
    'buyer',
    'Buyer Company',
    'many_to_one',
    '{}'::jsonb,
    'active'
  ),
  (
    'orders.customer_company_id__companies.id',
    'orders',
    'customer_company_id',
    'companies',
    'id',
    'fk',
    'customer',
    'Customer Company',
    'many_to_one',
    '{}'::jsonb,
    'active'
  ),
  (
    'orders.factory_company_id__companies.id',
    'orders',
    'factory_company_id',
    'companies',
    'id',
    'fk',
    'factory',
    'Factory Company',
    'many_to_one',
    '{}'::jsonb,
    'active'
  ),
  (
    'orders.issuing_company_id__companies.id',
    'orders',
    'issuing_company_id',
    'companies',
    'id',
    'fk',
    'issuing',
    'Issuing Company',
    'many_to_one',
    '{}'::jsonb,
    'active'
  ),
  (
    'orders.operating_company_id__companies.id',
    'orders',
    'operating_company_id',
    'companies',
    'id',
    'fk',
    'operating',
    'Operating Company',
    'many_to_one',
    '{}'::jsonb,
    'active'
  ),
  (
    'orders.owner_company_id__companies.id',
    'orders',
    'owner_company_id',
    'companies',
    'id',
    'fk',
    'owner',
    'Owner Company',
    'many_to_one',
    '{}'::jsonb,
    'active'
  ),
  (
    'orders.seller_company_id__companies.id',
    'orders',
    'seller_company_id',
    'companies',
    'id',
    'fk',
    'seller',
    'Seller Company',
    'many_to_one',
    '{}'::jsonb,
    'active'
  )
ON CONFLICT (relation_key) DO UPDATE SET
  from_module = EXCLUDED.from_module,
  from_field_key = EXCLUDED.from_field_key,
  to_module = EXCLUDED.to_module,
  to_field_key = EXCLUDED.to_field_key,
  relation_type = EXCLUDED.relation_type,
  role_key = EXCLUDED.role_key,
  label = EXCLUDED.label,
  cardinality = EXCLUDED.cardinality,
  resolution_json = EXCLUDED.resolution_json,
  status = EXCLUDED.status,
  updated_at = now();

INSERT INTO field_relations (
  relation_key,
  from_module,
  from_field_key,
  to_module,
  to_field_key,
  relation_type,
  role_key,
  label,
  cardinality,
  resolution_json,
  status
)
VALUES
  (
    'orders.shipping_plan_id__shipping_plans._id',
    'orders',
    'shipping_plan_id',
    'shipping_plans',
    '_id',
    'fk',
    'shipping_plan',
    'Shipping Plan',
    'many_to_one',
    '{}'::jsonb,
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'orders'
          AND column_name = 'shipping_plan_id'
      ) THEN 'active'
      ELSE 'inactive'
    END
  ),
  (
    'order_line_items.sku__products.sku',
    'order_line_items',
    'sku',
    'products',
    'sku',
    'logical',
    'product_master',
    'Product Master',
    'many_to_one',
    $json${"resolution":"DISTINCT ON (sku) over products, ignoring blank sku, ordered by active rows first, latest updated_at, latest id","sql":"SELECT DISTINCT ON (sku) * FROM products WHERE NULLIF(BTRIM(sku), '') IS NOT NULL ORDER BY sku, (status = 'active') DESC NULLS LAST, updated_at DESC NULLS LAST, id DESC NULLS LAST"}$json$::jsonb,
    'active'
  ),
  (
    'orders.id__order_line_items.order_id',
    'orders',
    'id',
    'order_line_items',
    'order_id',
    'subform',
    'line_items',
    'Line Items',
    'one_to_many',
    '{}'::jsonb,
    'active'
  )
ON CONFLICT (relation_key) DO UPDATE SET
  from_module = EXCLUDED.from_module,
  from_field_key = EXCLUDED.from_field_key,
  to_module = EXCLUDED.to_module,
  to_field_key = EXCLUDED.to_field_key,
  relation_type = EXCLUDED.relation_type,
  role_key = EXCLUDED.role_key,
  label = EXCLUDED.label,
  cardinality = EXCLUDED.cardinality,
  resolution_json = EXCLUDED.resolution_json,
  status = EXCLUDED.status,
  updated_at = now();

WITH source_columns AS (
  SELECT
    c.table_name AS module_key,
    c.column_name,
    c.data_type,
    c.udt_name,
    c.is_nullable,
    c.character_maximum_length
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name IN ('orders', 'order_line_items', 'products', 'shipping_plans', 'companies')
),
normalized_columns AS (
  SELECT
    sc.module_key,
    CASE
      WHEN fd.canonical_key IS NOT NULL AND fd.is_curated = true THEN 'raw__' || sc.column_name
      ELSE sc.column_name
    END AS field_key,
    CASE
      WHEN fd.canonical_key IS NOT NULL AND fd.is_curated = true THEN sc.module_key || '.raw__' || sc.column_name
      ELSE sc.module_key || '.' || sc.column_name
    END AS canonical_key,
    CASE
      WHEN fd.canonical_key IS NOT NULL AND fd.is_curated = true THEN
        'Raw ' || replace(replace(replace(replace(replace(replace(initcap(replace(sc.column_name, '_', ' ')), 'Id', 'ID'), 'Sku', 'SKU'), 'Cbm', 'CBM'), 'Hs', 'HS'), ' Bl ', ' BL '), ' Url', ' URL')
      ELSE
        replace(replace(replace(replace(replace(replace(initcap(replace(sc.column_name, '_', ' ')), 'Id', 'ID'), 'Sku', 'SKU'), 'Cbm', 'CBM'), 'Hs', 'HS'), ' Bl ', ' BL '), ' Url', ' URL')
    END AS label,
    CASE
      WHEN sc.data_type IN ('smallint', 'integer', 'bigint') THEN 'integer'
      WHEN sc.data_type IN ('numeric', 'decimal', 'real', 'double precision') THEN 'number'
      WHEN sc.data_type = 'boolean' THEN 'boolean'
      WHEN sc.data_type = 'date' THEN 'date'
      WHEN sc.data_type IN ('timestamp without time zone', 'timestamp with time zone') THEN 'datetime'
      WHEN sc.data_type IN ('json', 'jsonb', 'ARRAY') OR sc.udt_name LIKE '\_%' THEN 'json'
      ELSE 'string'
    END AS field_type,
    CASE sc.module_key
      WHEN 'orders' THEN 'order'
      WHEN 'order_line_items' THEN 'line_item'
      WHEN 'products' THEN 'master_data'
      WHEN 'shipping_plans' THEN 'shipping_plan'
      WHEN 'companies' THEN 'company'
    END AS grain,
    sc.column_name AS source_column,
    (
      jsonb_build_object('nullable', sc.is_nullable = 'YES')
      || CASE
        WHEN sc.character_maximum_length IS NOT NULL
          THEN jsonb_build_object('maxLength', sc.character_maximum_length)
        ELSE '{}'::jsonb
      END
    ) AS validation_json,
    CASE
      WHEN sc.module_key = 'orders'
        AND sc.column_name IN ('total_cbm', 'total_gross_weight', 'total_net_weight') THEN 'high'
      WHEN sc.column_name LIKE 'total\_%' ESCAPE '\'
        AND EXISTS (
          SELECT 1
          FROM field_definitions computed_fd
          WHERE computed_fd.canonical_key = sc.module_key || '.' || sc.column_name
            AND computed_fd.is_curated = true
            AND computed_fd.source_kind = 'computed'
        ) THEN 'high'
      ELSE NULL
    END AS stale_risk
  FROM source_columns sc
  LEFT JOIN field_definitions fd
    ON fd.canonical_key = sc.module_key || '.' || sc.column_name
)
INSERT INTO field_definitions (
  canonical_key,
  module_key,
  field_key,
  label,
  type,
  unit,
  format,
  is_legal,
  customs_relevant,
  grain,
  relationship_json,
  validation_json,
  status,
  source_kind,
  source_table,
  source_column,
  is_system_derived,
  is_curated,
  stale_risk
)
SELECT
  nc.canonical_key,
  nc.module_key,
  nc.field_key,
  nc.label,
  nc.field_type,
  NULL,
  '{}'::jsonb,
  false,
  false,
  nc.grain,
  '{}'::jsonb,
  nc.validation_json,
  'active',
  'raw_column',
  nc.module_key,
  nc.source_column,
  true,
  false,
  nc.stale_risk
FROM normalized_columns nc
ON CONFLICT (canonical_key) DO UPDATE SET
  source_kind = EXCLUDED.source_kind,
  source_table = EXCLUDED.source_table,
  source_column = EXCLUDED.source_column,
  is_system_derived = EXCLUDED.is_system_derived,
  is_curated = EXCLUDED.is_curated,
  customs_relevant = COALESCE(field_definitions.customs_relevant, EXCLUDED.customs_relevant),
  stale_risk = EXCLUDED.stale_risk,
  updated_at = now()
WHERE field_definitions.is_curated = false;

SELECT
  (SELECT COUNT(*) FROM field_definitions WHERE is_curated = true) AS curated_definition_count,
  (SELECT COUNT(*) FROM field_definitions WHERE source_kind = 'raw_column') AS raw_column_definition_count,
  (SELECT COUNT(*) FROM field_relations) AS relation_count,
  (SELECT COUNT(*) FROM field_lookups) AS lookup_count,
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN (
    'orders',
    'order_line_items',
    'products',
    'shipping_plans',
    'companies'
  )) AS introspected_table_count,
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'shipping_plan_id') AS orders_shipping_plan_id_column_count,
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'order_line_items' AND column_name = 'order_id') AS line_items_order_id_column_count;
