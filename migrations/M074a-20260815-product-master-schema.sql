-- M074a must run before M074b.
-- Shadow-run product master schema only. Does not change petstore_ops_row or product pages.
-- Cutover gate: product_master_shadow_diff where NOT is_expected must stay 0 for 3 consecutive days.

CREATE TABLE IF NOT EXISTS product_master (
  product_id bigserial PRIMARY KEY,
  standard_product_name text,
  standard_spec text,
  display_category text,
  brand text,
  pet_type text,
  shelf_life_days integer,
  expire_date_batch text,
  compliance_status text,
  show_in_catalog boolean NOT NULL DEFAULT true,
  notes text,
  pos_product_name text,
  pos_category text,
  pos_spec text,
  pos_brand text,
  pos_pet_type text,
  pos_shelf_life_days integer,
  pos_expire_date_batch text,
  pos_compliance_status text,
  cost_price numeric(12,2),
  out_price numeric(12,2),
  stock_num numeric(12,2),
  shelf_list text,
  barcode text,
  supplier text,
  pos_cost_price numeric(12,2),
  pos_out_price numeric(12,2),
  pos_stock_num numeric(12,2),
  pos_shelf_list text,
  pos_barcode text,
  pos_supplier text,
  source_of_truth_note text NOT NULL DEFAULT 'M074 shadow master; page still reads petstore_ops_row',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_external_ids (
  id bigserial PRIMARY KEY,
  product_id bigint NOT NULL REFERENCES product_master(product_id),
  source_system text NOT NULL DEFAULT 'jelly_orange',
  external_product_code text NOT NULL,
  barcode text,
  valid_from date NOT NULL DEFAULT current_date,
  valid_to date,
  is_current boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz,
  confidence numeric(5,4) NOT NULL DEFAULT 1,
  match_reason text NOT NULL DEFAULT 'source_product_code',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS product_external_ids_current_code_uk
  ON product_external_ids(source_system, external_product_code)
  WHERE is_current;

CREATE INDEX IF NOT EXISTS product_external_ids_product_idx
  ON product_external_ids(product_id);

CREATE TABLE IF NOT EXISTS product_field_default_ownership (
  field_name text PRIMARY KEY,
  owner text NOT NULL CHECK (owner IN ('ours','pos')),
  accept_source_updates boolean NOT NULL DEFAULT false,
  notes text
);

INSERT INTO product_field_default_ownership(field_name, owner, accept_source_updates, notes) VALUES
  ('standard_product_name','ours',false,'our canonical name'),
  ('standard_spec','ours',false,'our canonical spec'),
  ('display_category','ours',false,'our display category'),
  ('brand','ours',false,'supplemented brand'),
  ('pet_type','ours',false,'supplemented pet type'),
  ('shelf_life_days','ours',false,'supplemented shelf life'),
  ('expire_date_batch','ours',false,'supplemented expiry batch'),
  ('compliance_status','ours',false,'supplemented compliance status'),
  ('show_in_catalog','ours',false,'catalog visibility; not tied to own_brand'),
  ('notes','ours',false,'operator notes'),
  ('pos_product_name','pos',true,'last POS product name mirror'),
  ('pos_category','pos',true,'last POS category mirror'),
  ('pos_spec','pos',true,'last POS spec mirror'),
  ('cost_price','pos',true,'POS cost price'),
  ('out_price','pos',true,'POS sale price'),
  ('stock_num','pos',true,'POS stock'),
  ('shelf_list','pos',true,'POS shelf JSON text'),
  ('barcode','pos',true,'latest POS barcode from pricing log'),
  ('supplier','pos',true,'POS supplier')
ON CONFLICT (field_name) DO UPDATE SET
  owner = EXCLUDED.owner,
  accept_source_updates = EXCLUDED.accept_source_updates,
  notes = EXCLUDED.notes;

CREATE TABLE IF NOT EXISTS product_field_ownership_exceptions (
  product_id bigint NOT NULL REFERENCES product_master(product_id),
  field_name text NOT NULL REFERENCES product_field_default_ownership(field_name),
  owner text NOT NULL CHECK (owner IN ('ours','pos')),
  accept_source_updates boolean NOT NULL DEFAULT false,
  note text,
  locked_by bigint,
  locked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, field_name)
);

CREATE TABLE IF NOT EXISTS product_field_conflicts (
  id bigserial PRIMARY KEY,
  product_id bigint NOT NULL REFERENCES product_master(product_id),
  field_name text NOT NULL,
  master_value text,
  incoming_value text,
  last_seen_incoming_value text,
  incoming_source text NOT NULL DEFAULT 'jelly_orange',
  status text NOT NULL DEFAULT 'open',
  detected_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by bigint,
  resolution text
);

CREATE UNIQUE INDEX IF NOT EXISTS product_field_conflicts_open_uk
  ON product_field_conflicts(product_id, field_name)
  WHERE status = 'open';

CREATE OR REPLACE VIEW product_field_effective_ownership AS
SELECT
  pm.product_id,
  d.field_name,
  COALESCE(e.owner, d.owner) AS owner,
  COALESCE(e.accept_source_updates, d.accept_source_updates) AS accept_source_updates
FROM product_master pm
CROSS JOIN product_field_default_ownership d
LEFT JOIN product_field_ownership_exceptions e
  ON e.product_id = pm.product_id
 AND e.field_name = d.field_name;

CREATE OR REPLACE VIEW product_master_shadow_diff AS
WITH latest_sku AS (
  SELECT max(ps.snapshot_date) AS snapshot_date
  FROM petstore_skus ps
),
latest_barcode AS (
  SELECT DISTINCT ON (pl.product_code)
    pl.product_code,
    pl.barcode
  FROM petstore_pricing_log pl
  WHERE pl.barcode IS NOT NULL AND pl.barcode <> ''
  ORDER BY pl.product_code, pl.synced_at DESC NULLS LAST, pl.id DESC
),
src AS (
  SELECT
    ps.product_code,
    ps.product_name AS src_product_name,
    ps.category AS src_category,
    ps.spec AS src_spec,
    round(ps.cost_price::numeric, 2) AS src_cost_price,
    round(ps.out_price::numeric, 2) AS src_out_price,
    round(ps.stock_num::numeric, 2) AS src_stock_num,
    ps.shelf_list AS src_shelf_list,
    lb.barcode AS src_barcode,
    ps.supplier AS src_supplier,
    ss.brand AS src_brand,
    ss.pet_type AS src_pet_type,
    ss.shelf_life_days AS src_shelf_life_days,
    ss.expire_date_batch AS src_expire_date_batch,
    ss.compliance_status AS src_compliance_status
  FROM petstore_skus ps
  JOIN latest_sku ls ON ls.snapshot_date = ps.snapshot_date
  LEFT JOIN petstore_sku_supp ss ON ss.product_code = ps.product_code
  LEFT JOIN latest_barcode lb ON lb.product_code = ps.product_code
),
matched AS (
  SELECT
    pm.product_id,
    pei.external_product_code AS product_code,
    pm.standard_product_name AS mst_standard_product_name,
    pm.standard_spec AS mst_standard_spec,
    pm.display_category AS mst_display_category,
    pm.brand AS mst_brand,
    pm.pet_type AS mst_pet_type,
    pm.shelf_life_days AS mst_shelf_life_days,
    pm.expire_date_batch AS mst_expire_date_batch,
    pm.compliance_status AS mst_compliance_status,
    pm.show_in_catalog AS mst_show_in_catalog,
    pm.notes AS mst_notes,
    pm.pos_product_name AS mst_pos_product_name,
    pm.pos_category AS mst_pos_category,
    pm.pos_spec AS mst_pos_spec,
    pm.cost_price AS mst_cost_price,
    pm.out_price AS mst_out_price,
    pm.stock_num AS mst_stock_num,
    pm.shelf_list AS mst_shelf_list,
    pm.barcode AS mst_barcode,
    pm.supplier AS mst_supplier,
    src.src_product_name,
    src.src_category,
    src.src_spec,
    src.src_cost_price,
    src.src_out_price,
    src.src_stock_num,
    src.src_shelf_list,
    src.src_barcode,
    src.src_supplier,
    src.src_brand,
    src.src_pet_type,
    src.src_shelf_life_days,
    src.src_expire_date_batch,
    src.src_compliance_status
  FROM product_master pm
  JOIN product_external_ids pei
    ON pei.product_id = pm.product_id
   AND pei.source_system = 'jelly_orange'
   AND pei.is_current
  JOIN src ON src.product_code = pei.external_product_code
),
field_values AS (
  SELECT
    m.product_id,
    m.product_code,
    v.field_name,
    v.master_value,
    v.pos_value
  FROM matched m
  CROSS JOIN LATERAL (VALUES
    ('standard_product_name', m.mst_standard_product_name, m.src_product_name),
    ('standard_spec', m.mst_standard_spec, m.src_spec),
    ('display_category', m.mst_display_category, m.src_category),
    ('brand', m.mst_brand, m.src_brand),
    ('pet_type', m.mst_pet_type, m.src_pet_type),
    ('shelf_life_days', m.mst_shelf_life_days::text, m.src_shelf_life_days::text),
    ('expire_date_batch', m.mst_expire_date_batch, m.src_expire_date_batch),
    ('compliance_status', m.mst_compliance_status, m.src_compliance_status),
    ('show_in_catalog', m.mst_show_in_catalog::text, NULL),
    ('notes', m.mst_notes, NULL),
    ('pos_product_name', m.mst_pos_product_name, m.src_product_name),
    ('pos_category', m.mst_pos_category, m.src_category),
    ('pos_spec', m.mst_pos_spec, m.src_spec),
    ('cost_price', m.mst_cost_price::text, m.src_cost_price::text),
    ('out_price', m.mst_out_price::text, m.src_out_price::text),
    ('stock_num', m.mst_stock_num::text, m.src_stock_num::text),
    ('shelf_list', m.mst_shelf_list, m.src_shelf_list),
    ('barcode', m.mst_barcode, m.src_barcode),
    ('supplier', m.mst_supplier, m.src_supplier)
  ) AS v(field_name, master_value, pos_value)
)
SELECT
  fv.product_id,
  fv.product_code,
  fv.field_name,
  fv.master_value,
  fv.pos_value,
  eo.owner,
  (eo.owner = 'ours') AS is_expected
FROM field_values fv
JOIN product_field_effective_ownership eo
  ON eo.product_id = fv.product_id
 AND eo.field_name = fv.field_name
WHERE fv.master_value IS DISTINCT FROM fv.pos_value;
