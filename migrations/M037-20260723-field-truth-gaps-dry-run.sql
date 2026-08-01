-- M037 2026-07-23 field truth gate + data gap generator dry-run
-- Scope: artifact only. Do not apply from this file.
-- Red lines:
--   1. No external submission writes master data directly.
--   2. No guessed values, placeholders, or AI-estimated values count as verified.
--   3. Only document_missing_items gets new anchor columns.
--   4. This file must stay dry-run: final statement is ROLLBACK.

BEGIN;

-- ---------------------------------------------------------------------
-- Preflight: required tables and columns from field-truth-SCHEMA-PACK.txt.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  missing text;
BEGIN
  WITH required(table_name, column_name) AS (
    VALUES
      ('document_missing_items','id'),
      ('document_missing_items','_id'),
      ('document_missing_items','shipment_no'),
      ('document_missing_items','contract_no'),
      ('document_missing_items','issue_type'),
      ('document_missing_items','severity'),
      ('document_missing_items','field_name'),
      ('document_missing_items','description'),
      ('document_missing_items','expected_val'),
      ('document_missing_items','actual_val'),
      ('document_missing_items','status'),
      ('document_missing_items','auto_generated'),
      ('document_missing_items','raw'),
      ('field_definitions','module_key'),
      ('field_definitions','field_key'),
      ('field_definitions','validation_json'),
      ('products','id'),
      ('products','sku'),
      ('products','product_name'),
      ('products','spec'),
      ('products','spec_source'),
      ('products','spec_verified'),
      ('products','spec_verified_at'),
      ('products','spec_verified_by'),
      ('products','unit'),
      ('products','factory_price'),
      ('products','raw'),
      ('products','supplier_company_id'),
      ('products','updated_at'),
      ('orders','id'),
      ('orders','order_no'),
      ('orders','contract_no'),
      ('orders','deleted_at'),
      ('orders','buyer_company_id'),
      ('orders','factory_company_id'),
      ('orders','customer_company_id'),
      ('order_line_items','id'),
      ('order_line_items','order_id'),
      ('order_line_items','product_id'),
      ('order_line_items','sku'),
      ('order_line_items','factory_price'),
      ('order_line_items','unit_price'),
      ('order_line_items','declare_amount_per_box'),
      ('order_line_items','cbm_ctn'),
      ('order_line_items','cbm_source'),
      ('collab_submissions','id'),
      ('collab_submissions','magic_link_id'),
      ('collab_submissions','submitter_role'),
      ('collab_submissions','intent'),
      ('collab_submissions','target_kind'),
      ('collab_submissions','target_ref'),
      ('collab_submissions','payload'),
      ('collab_submissions','field_diffs'),
      ('collab_submissions','attachments'),
      ('collab_submissions','status'),
      ('collab_submissions','applied_to'),
      ('collab_urges','id'),
      ('collab_urges','sheet_id'),
      ('collab_urges','sheet_table'),
      ('collab_urges','target_role'),
      ('magic_links','id'),
      ('magic_links','token_hash'),
      ('magic_links','recipient_role'),
      ('magic_links','meta'),
      ('magic_links','expires_at'),
      ('magic_links','revoked_at'),
      ('magic_links','revoked')
  ),
  miss AS (
    SELECT r.table_name || '.' || r.column_name AS key
    FROM required r
    LEFT JOIN information_schema.columns c
      ON c.table_schema = 'public'
     AND c.table_name = r.table_name
     AND c.column_name = r.column_name
    WHERE c.column_name IS NULL
  )
  SELECT string_agg(key, ', ' ORDER BY key) INTO missing FROM miss;

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'M037 preflight failed, missing: %', missing;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- L2 schema: master-data anchors on document_missing_items only.
-- ---------------------------------------------------------------------
ALTER TABLE document_missing_items ADD COLUMN IF NOT EXISTS module_key text;
ALTER TABLE document_missing_items ADD COLUMN IF NOT EXISTS record_id text;
ALTER TABLE document_missing_items ADD COLUMN IF NOT EXISTS owner_company_id integer;
ALTER TABLE document_missing_items ADD COLUMN IF NOT EXISTS required_source text;

CREATE INDEX IF NOT EXISTS idx_dmi_master_gap_scope
  ON document_missing_items(module_key, record_id, field_name, status);

CREATE INDEX IF NOT EXISTS idx_dmi_owner_company_open
  ON document_missing_items(owner_company_id, status, created_at);

COMMENT ON COLUMN document_missing_items.module_key IS
  'M037: master-data gap anchor module, e.g. products|companies|orders|order_line_items.';
COMMENT ON COLUMN document_missing_items.record_id IS
  'M037: master-data gap anchor primary key as text.';
COMMENT ON COLUMN document_missing_items.owner_company_id IS
  'M037: company expected to provide the missing field or evidence.';
COMMENT ON COLUMN document_missing_items.required_source IS
  'M037: truth requirement: contract|measured|master_verified|derived|free.';

-- ---------------------------------------------------------------------
-- L1 catalog: store truth_requirement in existing validation_json.
-- No field_definitions schema change.
-- ---------------------------------------------------------------------
WITH truth_seed(module_key, field_key, truth_requirement) AS (
  VALUES
    ('products','factory_price','contract'),
    ('products','price_usd','contract'),
    ('products','declaration_amount','contract'),
    ('products','spec','master_verified'),
    ('products','unit','master_verified'),
    ('products','cbm','master_verified'),
    ('products','net_weight','master_verified'),
    ('products','gross_weight','master_verified'),
    ('products','hs_code','contract'),
    ('products','declaration_name','contract'),
    ('products','declaration_elements','contract'),
    ('order_line_items','factory_price','contract'),
    ('order_line_items','unit_price','contract'),
    ('order_line_items','declare_amount_per_box','contract'),
    ('order_line_items','cbm_ctn','master_verified'),
    ('orders','declare_amount','contract'),
    ('orders','factory_total_amount','derived'),
    ('orders','customer_total_amount','derived'),
    ('orders','total_net_weight_kg','derived'),
    ('orders','total_cartons','derived'),
    ('orders','factory_company_id','master_verified'),
    ('orders','buyer_company_id','master_verified'),
    ('orders','customer_company_id','master_verified')
)
UPDATE field_definitions fd
SET validation_json = jsonb_set(
      COALESCE(fd.validation_json, '{}'::jsonb),
      '{truth_requirement}',
      to_jsonb(ts.truth_requirement),
      true
    ),
    updated_at = now()
FROM truth_seed ts
WHERE fd.module_key = ts.module_key
  AND fd.field_key = ts.field_key;

-- Downgrade known non-truth sources inside the dry-run transaction.
-- Keep a temp snapshot first so gap generation reports the rows that were
-- falsely marked verified before this transaction corrected the marker.
CREATE TEMP TABLE m037_unverified_products AS
  SELECT p.id,
         p.sku,
         p.product_name,
         p.spec_source,
         p.supplier_company_id,
         'products:' || p.id || ':spec:source_not_verified' AS gap_key
  FROM products p
  WHERE COALESCE(p.spec_verified, false) = true
    AND COALESCE(p.spec_source, '') IN ('ai_estimated', 'auto_fill_by_similar', 'estimated_per_item');

UPDATE products p
SET spec_verified = false,
    spec_verified_at = NULL,
    spec_verified_by = NULL,
    updated_at = now()
WHERE EXISTS (
  SELECT 1
  FROM m037_unverified_products u
  WHERE u.id = p.id
);

WITH unverified_products AS (
  SELECT * FROM m037_unverified_products
),
seed_pollution AS (
  SELECT p.id,
         p.sku,
         p.product_name,
         p.spec_source,
         p.supplier_company_id,
         'products:' || p.id || ':factory_price:copied_constant_20260606' AS gap_key
  FROM products p
  WHERE p.id BETWEEN 1667 AND 1673
    AND p.factory_price = 22.45
),
dfc_price_pollution AS (
  SELECT p.id,
         p.sku,
         p.product_name,
         p.spec_source,
         p.supplier_company_id,
         'products:' || p.id || ':factory_price:dfc_50g_500g_price_mix' AS gap_key
  FROM products p
  WHERE p.id = 46
     OR (upper(p.sku) = 'DFC-02' AND COALESCE(p.spec, '') ILIKE '%50G%')
),
candidate_gaps AS (
  SELECT
    gap_key,
    'products'::text AS module_key,
    id::text AS record_id,
    supplier_company_id::integer AS owner_company_id,
    'master_verified'::text AS required_source,
    'spec'::text AS field_name,
    'truth_source_not_verified'::text AS issue_type,
    'error'::text AS severity,
    'Product spec is marked verified from an estimated source; factory/customer evidence is required.'::text AS description,
    'source not in ai_estimated/auto_fill_by_similar/estimated_per_item'::text AS expected_val,
    COALESCE(spec_source, '')::text AS actual_val,
    jsonb_build_object('sku', sku, 'product_name', product_name, 'rule', 'unverified_spec_source') AS raw
  FROM unverified_products
  UNION ALL
  SELECT
    gap_key,
    'products',
    id::text,
    supplier_company_id::integer,
    'contract',
    'factory_price',
    'copied_value_suspected',
    'critical',
    'Factory price matches the known 2026-06-06 copied 22.45 batch; contract evidence is required.',
    'contract-backed factory_price',
    '22.45',
    jsonb_build_object('sku', sku, 'product_name', product_name, 'rule', 'copied_constant_20260606')
  FROM seed_pollution
  UNION ALL
  SELECT
    gap_key,
    'products',
    id::text,
    supplier_company_id::integer,
    'contract',
    'factory_price',
    'price_source_conflict',
    'critical',
    'DFC-02 50G row appears to carry a 500G price; contract evidence is required before use.',
    'contract-backed DFC-02 50G factory_price',
    NULL,
    jsonb_build_object('sku', sku, 'product_name', product_name, 'rule', 'dfc_50g_500g_price_mix')
  FROM dfc_price_pollution
)
INSERT INTO document_missing_items (
  _id,
  shipment_no,
  contract_no,
  issue_type,
  severity,
  field_name,
  doc_type,
  description,
  expected_val,
  actual_val,
  status,
  auto_generated,
  raw,
  module_key,
  record_id,
  owner_company_id,
  required_source,
  created_at,
  updated_at
)
SELECT
  'M037:' || g.gap_key AS _id,
  'MASTER:' || g.module_key || ':' || g.record_id AS shipment_no,
  NULL AS contract_no,
  g.issue_type,
  g.severity,
  g.field_name,
  'master_data_truth' AS doc_type,
  g.description,
  g.expected_val,
  g.actual_val,
  'open' AS status,
  true AS auto_generated,
  g.raw || jsonb_build_object('gap_key', g.gap_key, 'source', 'M037-field-truth-gaps-dry-run'),
  g.module_key,
  g.record_id,
  g.owner_company_id,
  g.required_source,
  now(),
  now()
FROM candidate_gaps g
WHERE NOT EXISTS (
  SELECT 1
  FROM document_missing_items d
  WHERE d.raw->>'gap_key' = g.gap_key
     OR d._id = 'M037:' || g.gap_key
);

-- ---------------------------------------------------------------------
-- Dry-run reports for Damon/Claude review.
-- ---------------------------------------------------------------------
SELECT 'field_definitions truth_requirement seeded in transaction' AS report,
       module_key,
       validation_json->>'truth_requirement' AS truth_requirement,
       count(*) AS field_count
FROM field_definitions
WHERE validation_json ? 'truth_requirement'
GROUP BY module_key, validation_json->>'truth_requirement'
ORDER BY module_key, truth_requirement;

SELECT 'product spec_verified downgraded in transaction' AS report,
       spec_source,
       count(*) AS downgraded_count
FROM m037_unverified_products
GROUP BY spec_source
ORDER BY spec_source;

SELECT 'open master-data gaps inserted in transaction' AS report,
       module_key,
       field_name,
       required_source,
       severity,
       count(*) AS gap_count,
       count(*) FILTER (WHERE owner_company_id IS NULL) AS missing_owner_company_id
FROM document_missing_items
WHERE raw->>'source' = 'M037-field-truth-gaps-dry-run'
GROUP BY module_key, field_name, required_source, severity
ORDER BY severity DESC, module_key, field_name;

SELECT 'sample M037 gaps' AS report,
       id,
       _id,
       module_key,
       record_id,
       owner_company_id,
       field_name,
       required_source,
       severity,
       actual_val,
       raw
FROM document_missing_items
WHERE raw->>'source' = 'M037-field-truth-gaps-dry-run'
ORDER BY id
LIMIT 50;

ROLLBACK;
