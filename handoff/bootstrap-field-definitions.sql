-- Bootstrap field_definitions for tables that have no definitions yet.
-- Review only. Do not run from Codex.
-- Defaults show_in_business=false so newly bootstrapped modules do not flood pages.

WITH target_tables AS (
  SELECT c.table_name
  FROM information_schema.tables c
  WHERE c.table_schema = 'public'
    AND c.table_type = 'BASE TABLE'
    AND NOT EXISTS (
      SELECT 1
      FROM field_definitions fd
      WHERE fd.module_key = c.table_name
    )
),
source_columns AS (
  SELECT
    col.table_name,
    col.column_name,
    col.ordinal_position,
    col.data_type
  FROM information_schema.columns col
  JOIN target_tables tt ON tt.table_name = col.table_name
  WHERE col.table_schema = 'public'
)
INSERT INTO field_definitions (
  canonical_key,
  module_key,
  field_key,
  label,
  label_cn,
  type,
  input_kind,
  options_json,
  unit,
  format,
  sort_order,
  col_span,
  section_key,
  section_label_cn,
  tab,
  visible_roles,
  editable_roles,
  editable,
  show_in_business,
  show_in_edit,
  required_for_completeness,
  status,
  source_kind,
  source_table,
  source_column
)
SELECT
  sc.table_name || '.' || sc.column_name AS canonical_key,
  sc.table_name AS module_key,
  sc.column_name AS field_key,
  sc.column_name AS label,
  NULL AS label_cn,
  CASE
    WHEN sc.data_type IN ('smallint','integer','bigint','numeric','decimal','real','double precision','money') THEN 'number'
    WHEN sc.data_type IN ('date') THEN 'date'
    WHEN sc.data_type LIKE '%time%' THEN 'datetime'
    WHEN sc.data_type IN ('boolean') THEN 'boolean'
    WHEN sc.data_type IN ('json','jsonb') THEN 'json'
    ELSE 'text'
  END AS type,
  CASE
    WHEN sc.data_type IN ('smallint','integer','bigint','numeric','decimal','real','double precision','money') THEN 'number'
    WHEN sc.data_type IN ('date') THEN 'date'
    WHEN sc.data_type LIKE '%time%' THEN 'datetime'
    WHEN sc.data_type IN ('boolean') THEN 'checkbox'
    WHEN sc.data_type IN ('json','jsonb') THEN 'json'
    ELSE 'text'
  END AS input_kind,
  NULL::jsonb AS options_json,
  NULL AS unit,
  NULL::jsonb AS format,
  sc.ordinal_position AS sort_order,
  1 AS col_span,
  'default' AS section_key,
  NULL AS section_label_cn,
  'default' AS tab,
  '["admin"]'::jsonb AS visible_roles,
  '["admin"]'::jsonb AS editable_roles,
  false AS editable,
  false AS show_in_business,
  false AS show_in_edit,
  false AS required_for_completeness,
  'active' AS status,
  'auto_bootstrap' AS source_kind,
  sc.table_name AS source_table,
  sc.column_name AS source_column
FROM source_columns sc
WHERE NOT EXISTS (
  SELECT 1
  FROM field_definitions fd
  WHERE fd.module_key = sc.table_name
    AND fd.field_key = sc.column_name
);
