-- M036 2026-07-23 orders company/product relations dry-run
-- Scope: M1/M1b/M2/M3/M4/M5/M6 artifact only. Do not apply from this file.
-- Red lines:
--   1. Do not recalculate OLI-derived quantities, weights, CBM, or amounts.
--   2. Do not write BABI into orders.factory_code.
--   3. Backfills are COALESCE/fill-empty only.
--   4. Unresolved rows are reported, not guessed.

BEGIN;

-- ---------------------------------------------------------------------
-- Preflight: required tables and columns.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  missing text;
BEGIN
  WITH required(table_name, column_name) AS (
    VALUES
      ('orders','id'),
      ('orders','order_no'),
      ('orders','company_code'),
      ('orders','seller_code'),
      ('orders','factory_code'),
      ('orders','issuing_company'),
      ('companies','id'),
      ('companies','code'),
      ('companies','name_cn'),
      ('seller_profiles','code'),
      ('order_line_items','order_id'),
      ('order_line_items','product_id'),
      ('products','id'),
      ('products','sku'),
      ('field_relations','relation_key'),
      ('field_lookups','lookup_key'),
      ('partner_relationships','company_code_a'),
      ('partner_relationships','company_code_b'),
      ('partner_relationships','relationship_type')
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
    RAISE EXCEPTION 'M036 preflight failed, missing: %', missing;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- M1/M2/M4 schema additions. They are inside ROLLBACK for dry-run.
-- ---------------------------------------------------------------------
ALTER TABLE orders ADD COLUMN IF NOT EXISTS seller_company_id integer;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS buyer_company_id integer;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_company_id integer;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS issuing_company_id integer;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS operating_company_id integer;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS owner_company_id integer;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS factory_company_id integer;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS supplier_company_id integer;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS supplier_role_at_hop text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS trader_company_id integer;

ALTER TABLE seller_profiles ADD COLUMN IF NOT EXISTS company_id integer;
ALTER TABLE partner_relationships ADD COLUMN IF NOT EXISTS role_at_hop text;

CREATE INDEX IF NOT EXISTS idx_orders_seller_company_id ON orders(seller_company_id);
CREATE INDEX IF NOT EXISTS idx_orders_buyer_company_id ON orders(buyer_company_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer_company_id ON orders(customer_company_id);
CREATE INDEX IF NOT EXISTS idx_orders_issuing_company_id ON orders(issuing_company_id);
CREATE INDEX IF NOT EXISTS idx_orders_factory_company_id ON orders(factory_company_id);
CREATE INDEX IF NOT EXISTS idx_orders_supplier_company_id ON orders(supplier_company_id);
CREATE INDEX IF NOT EXISTS idx_orders_trader_company_id ON orders(trader_company_id);
CREATE INDEX IF NOT EXISTS idx_seller_profiles_company_id ON seller_profiles(company_id);

COMMENT ON COLUMN orders.supplier_company_id IS
  'M036: selected upstream supplier hop. Can point to trader or factory; do not confuse with factory_company_id.';
COMMENT ON COLUMN orders.supplier_role_at_hop IS
  'M036: supplier hop role, expected factory|trader. BABI as trader belongs here, never in factory_code.';
COMMENT ON COLUMN orders.trader_company_id IS
  'M036: trader hop company id when supplier_role_at_hop=trader.';
COMMENT ON COLUMN seller_profiles.company_id IS
  'M036: seller_profiles is issuing document config; legal company identity comes from companies.id.';

-- Add NOT VALID FKs only when they do not already exist. Validation is a
-- separate human apply step after the dry-run counts are accepted.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_seller_company_id_fkey') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_seller_company_id_fkey
      FOREIGN KEY (seller_company_id) REFERENCES companies(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_buyer_company_id_fkey') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_buyer_company_id_fkey
      FOREIGN KEY (buyer_company_id) REFERENCES companies(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_customer_company_id_fkey') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_customer_company_id_fkey
      FOREIGN KEY (customer_company_id) REFERENCES companies(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_issuing_company_id_fkey') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_issuing_company_id_fkey
      FOREIGN KEY (issuing_company_id) REFERENCES companies(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_operating_company_id_fkey') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_operating_company_id_fkey
      FOREIGN KEY (operating_company_id) REFERENCES companies(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_owner_company_id_fkey') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_owner_company_id_fkey
      FOREIGN KEY (owner_company_id) REFERENCES companies(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_factory_company_id_fkey') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_factory_company_id_fkey
      FOREIGN KEY (factory_company_id) REFERENCES companies(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_supplier_company_id_fkey') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_supplier_company_id_fkey
      FOREIGN KEY (supplier_company_id) REFERENCES companies(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_trader_company_id_fkey') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_trader_company_id_fkey
      FOREIGN KEY (trader_company_id) REFERENCES companies(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seller_profiles_company_id_fkey') THEN
    ALTER TABLE seller_profiles ADD CONSTRAINT seller_profiles_company_id_fkey
      FOREIGN KEY (company_id) REFERENCES companies(id) NOT VALID;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- M4: seller_profiles becomes issuing-document config. Fill company_id only.
-- ---------------------------------------------------------------------
WITH seller_map(code, company_id) AS (
  VALUES
    ('BABI', 37),
    ('petbaby', 37),
    ('OCEANBABY', 38),
    ('yangbaobao', 38)
)
UPDATE seller_profiles sp
SET company_id = COALESCE(sp.company_id, sm.company_id)
FROM seller_map sm
WHERE lower(sp.code) = lower(sm.code)
  AND sp.company_id IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='seller_profiles' AND column_name='name_cn') THEN
    COMMENT ON COLUMN seller_profiles.name_cn IS 'M036 deprecated: company identity belongs to companies.name_cn; keep only as legacy snapshot.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='seller_profiles' AND column_name='name_en') THEN
    COMMENT ON COLUMN seller_profiles.name_en IS 'M036 deprecated: company identity belongs to companies.name_en; keep only as legacy snapshot.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='seller_profiles' AND column_name='address') THEN
    COMMENT ON COLUMN seller_profiles.address IS 'M036 deprecated: company identity belongs to companies.address; keep only as legacy snapshot.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='seller_profiles' AND column_name='tax_no') THEN
    COMMENT ON COLUMN seller_profiles.tax_no IS 'M036 deprecated: company identity belongs to companies.tax_id; keep only as legacy snapshot.';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- M1: fill orders company FKs. All writes are fill-empty only.
-- ---------------------------------------------------------------------
WITH seller_map(code, company_id) AS (
  VALUES
    ('BABI', 37),
    ('petbaby', 37),
    ('OCEANBABY', 38),
    ('yangbaobao', 38)
)
UPDATE orders o
SET seller_company_id = COALESCE(o.seller_company_id, sm.company_id)
FROM seller_map sm
WHERE o.seller_company_id IS NULL
  AND lower(o.seller_code) = lower(sm.code);

WITH customer_match AS (
  SELECT o.id AS order_id, c.id AS company_id
  FROM orders o
  JOIN companies c ON c.code = o.company_code
  WHERE NULLIF(btrim(o.company_code), '') IS NOT NULL
)
UPDATE orders o
SET buyer_company_id = COALESCE(o.buyer_company_id, cm.company_id),
    customer_company_id = COALESCE(o.customer_company_id, cm.company_id)
FROM customer_match cm
WHERE o.id = cm.order_id
  AND (o.buyer_company_id IS NULL OR o.customer_company_id IS NULL);

WITH factory_match AS (
  SELECT o.id AS order_id, c.id AS company_id
  FROM orders o
  JOIN companies c ON c.code = o.factory_code
  WHERE NULLIF(btrim(o.factory_code), '') IS NOT NULL
)
UPDATE orders o
SET factory_company_id = COALESCE(o.factory_company_id, fm.company_id)
FROM factory_match fm
WHERE o.id = fm.order_id
  AND o.factory_company_id IS NULL;

WITH issuing_name_matches AS (
  SELECT o.id AS order_id, min(c.id) AS company_id, count(*) AS n
  FROM orders o
  JOIN companies c ON btrim(c.name_cn) = btrim(o.issuing_company)
  WHERE o.issuing_company_id IS NULL
    AND NULLIF(btrim(o.issuing_company), '') IS NOT NULL
  GROUP BY o.id
),
issuing_resolved AS (
  SELECT o.id AS order_id, COALESCE(o.seller_company_id, inm.company_id) AS company_id
  FROM orders o
  LEFT JOIN issuing_name_matches inm ON inm.order_id = o.id AND inm.n = 1
  WHERE o.issuing_company_id IS NULL
    AND COALESCE(o.seller_company_id, inm.company_id) IS NOT NULL
)
UPDATE orders o
SET issuing_company_id = COALESCE(o.issuing_company_id, ir.company_id)
FROM issuing_resolved ir
WHERE o.id = ir.order_id
  AND o.issuing_company_id IS NULL;

-- M2: historical supplier hop can only be filled when buyer has one active
-- customer_factory edge. Ambiguous buyers remain unresolved.
WITH active_edges AS (
  SELECT
    pr.company_code_a,
    min(pr.company_code_b) AS supplier_code,
    min(COALESCE(NULLIF(btrim(pr.role_at_hop), ''), CASE WHEN upper(pr.company_code_b) = 'BABI' THEN 'trader' ELSE 'factory' END)) AS role_at_hop,
    count(*) AS edge_count
  FROM partner_relationships pr
  WHERE pr.relationship_type = 'customer_factory'
    AND COALESCE(pr.status, 'active') = 'active'
  GROUP BY pr.company_code_a
),
unique_edges AS (
  SELECT ae.company_code_a, ae.supplier_code, ae.role_at_hop, c.id AS supplier_company_id
  FROM active_edges ae
  JOIN companies c ON c.code = ae.supplier_code
  WHERE ae.edge_count = 1
)
UPDATE orders o
SET supplier_company_id = COALESCE(o.supplier_company_id, ue.supplier_company_id),
    supplier_role_at_hop = COALESCE(NULLIF(o.supplier_role_at_hop, ''), ue.role_at_hop),
    trader_company_id = COALESCE(
      o.trader_company_id,
      CASE WHEN ue.role_at_hop = 'trader' THEN ue.supplier_company_id ELSE NULL END
    )
FROM unique_edges ue
WHERE o.company_code = ue.company_code_a
  AND (o.supplier_company_id IS NULL OR NULLIF(o.supplier_role_at_hop, '') IS NULL OR o.trader_company_id IS NULL);

-- 39-LL-23 stop-gap: set seller_company_id only, not seller_code.
UPDATE orders
SET seller_company_id = COALESCE(seller_company_id, 37),
    issuing_company_id = COALESCE(issuing_company_id, 37)
WHERE order_no = '39-LL-23';

-- ---------------------------------------------------------------------
-- M3/M5: field relations and lookups. Each orders->companies relation is
-- independent and has its own role_key.
-- ---------------------------------------------------------------------
WITH rel(relation_key, from_module, from_field_key, to_module, to_field_key, relation_type, role_key, label, cardinality, resolution_json) AS (
  VALUES
    ('orders.seller_company_id__companies.id', 'orders', 'seller_company_id', 'companies', 'id', 'fk', 'seller', 'orders seller company', 'many_to_one', '{"source":"M036","mode":"id"}'::jsonb),
    ('orders.buyer_company_id__companies.id', 'orders', 'buyer_company_id', 'companies', 'id', 'fk', 'buyer', 'orders buyer company', 'many_to_one', '{"source":"M036","mode":"id"}'::jsonb),
    ('orders.customer_company_id__companies.id', 'orders', 'customer_company_id', 'companies', 'id', 'fk', 'customer', 'orders customer company', 'many_to_one', '{"source":"M036","mode":"id"}'::jsonb),
    ('orders.issuing_company_id__companies.id', 'orders', 'issuing_company_id', 'companies', 'id', 'fk', 'issuing', 'orders issuing company', 'many_to_one', '{"source":"M036","mode":"id"}'::jsonb),
    ('orders.operating_company_id__companies.id', 'orders', 'operating_company_id', 'companies', 'id', 'fk', 'operating', 'orders operating company', 'many_to_one', '{"source":"M036","mode":"id"}'::jsonb),
    ('orders.owner_company_id__companies.id', 'orders', 'owner_company_id', 'companies', 'id', 'fk', 'owner', 'orders owner company', 'many_to_one', '{"source":"M036","mode":"id"}'::jsonb),
    ('orders.factory_company_id__companies.id', 'orders', 'factory_company_id', 'companies', 'id', 'fk', 'factory', 'orders factory company', 'many_to_one', '{"source":"M036","mode":"id"}'::jsonb),
    ('orders.supplier_company_id__companies.id', 'orders', 'supplier_company_id', 'companies', 'id', 'fk', 'supplier', 'orders supplier hop', 'many_to_one', '{"source":"M036","mode":"id","role_field":"supplier_role_at_hop"}'::jsonb),
    ('orders.trader_company_id__companies.id', 'orders', 'trader_company_id', 'companies', 'id', 'fk', 'trader', 'orders trader hop', 'many_to_one', '{"source":"M036","mode":"id"}'::jsonb),
    ('orders.id__order_line_items.order_id', 'orders', 'id', 'order_line_items', 'order_id', 'subform', 'items', 'order line items', 'one_to_many', '{"source":"M036"}'::jsonb),
    ('order_line_items.product_id__products.id', 'order_line_items', 'product_id', 'products', 'id', 'fk', 'product', 'line item product', 'many_to_one', '{"source":"M036","mode":"id"}'::jsonb),
    ('order_line_items.sku__products.sku', 'order_line_items', 'sku', 'products', 'sku', 'logical', 'product_sku', 'line item SKU to products SKU', 'many_to_one', '{"source":"M036","resolution":"DISTINCT ON (sku), prefer active/non-deprecated/latest id; report duplicate SKU ambiguity"}'::jsonb)
)
UPDATE field_relations fr
SET from_module = rel.from_module,
    from_field_key = rel.from_field_key,
    to_module = rel.to_module,
    to_field_key = rel.to_field_key,
    relation_type = rel.relation_type,
    role_key = rel.role_key,
    label = rel.label,
    cardinality = rel.cardinality,
    resolution_json = rel.resolution_json,
    status = 'active'
FROM rel
WHERE fr.relation_key = rel.relation_key;

WITH rel(relation_key, from_module, from_field_key, to_module, to_field_key, relation_type, role_key, label, cardinality, resolution_json) AS (
  VALUES
    ('orders.seller_company_id__companies.id', 'orders', 'seller_company_id', 'companies', 'id', 'fk', 'seller', 'orders seller company', 'many_to_one', '{"source":"M036","mode":"id"}'::jsonb),
    ('orders.buyer_company_id__companies.id', 'orders', 'buyer_company_id', 'companies', 'id', 'fk', 'buyer', 'orders buyer company', 'many_to_one', '{"source":"M036","mode":"id"}'::jsonb),
    ('orders.customer_company_id__companies.id', 'orders', 'customer_company_id', 'companies', 'id', 'fk', 'customer', 'orders customer company', 'many_to_one', '{"source":"M036","mode":"id"}'::jsonb),
    ('orders.issuing_company_id__companies.id', 'orders', 'issuing_company_id', 'companies', 'id', 'fk', 'issuing', 'orders issuing company', 'many_to_one', '{"source":"M036","mode":"id"}'::jsonb),
    ('orders.operating_company_id__companies.id', 'orders', 'operating_company_id', 'companies', 'id', 'fk', 'operating', 'orders operating company', 'many_to_one', '{"source":"M036","mode":"id"}'::jsonb),
    ('orders.owner_company_id__companies.id', 'orders', 'owner_company_id', 'companies', 'id', 'fk', 'owner', 'orders owner company', 'many_to_one', '{"source":"M036","mode":"id"}'::jsonb),
    ('orders.factory_company_id__companies.id', 'orders', 'factory_company_id', 'companies', 'id', 'fk', 'factory', 'orders factory company', 'many_to_one', '{"source":"M036","mode":"id"}'::jsonb),
    ('orders.supplier_company_id__companies.id', 'orders', 'supplier_company_id', 'companies', 'id', 'fk', 'supplier', 'orders supplier hop', 'many_to_one', '{"source":"M036","mode":"id","role_field":"supplier_role_at_hop"}'::jsonb),
    ('orders.trader_company_id__companies.id', 'orders', 'trader_company_id', 'companies', 'id', 'fk', 'trader', 'orders trader hop', 'many_to_one', '{"source":"M036","mode":"id"}'::jsonb),
    ('orders.id__order_line_items.order_id', 'orders', 'id', 'order_line_items', 'order_id', 'subform', 'items', 'order line items', 'one_to_many', '{"source":"M036"}'::jsonb),
    ('order_line_items.product_id__products.id', 'order_line_items', 'product_id', 'products', 'id', 'fk', 'product', 'line item product', 'many_to_one', '{"source":"M036","mode":"id"}'::jsonb),
    ('order_line_items.sku__products.sku', 'order_line_items', 'sku', 'products', 'sku', 'logical', 'product_sku', 'line item SKU to products SKU', 'many_to_one', '{"source":"M036","resolution":"DISTINCT ON (sku), prefer active/non-deprecated/latest id; report duplicate SKU ambiguity"}'::jsonb)
)
INSERT INTO field_relations (
  relation_key, from_module, from_field_key, to_module, to_field_key,
  relation_type, role_key, label, cardinality, resolution_json, status
)
SELECT
  rel.relation_key, rel.from_module, rel.from_field_key, rel.to_module, rel.to_field_key,
  rel.relation_type, rel.role_key, rel.label, rel.cardinality, rel.resolution_json, 'active'
FROM rel
WHERE NOT EXISTS (
  SELECT 1 FROM field_relations fr WHERE fr.relation_key = rel.relation_key
);

WITH lookup(lookup_key, module_key, target_field_key, relation_key, related_module, related_field_key, mode, is_readonly) AS (
  VALUES
    ('orders.seller.name_cn', 'orders', 'seller_company_id', 'orders.seller_company_id__companies.id', 'companies', 'name_cn', 'snapshot', true),
    ('orders.seller.name_en', 'orders', 'seller_company_id', 'orders.seller_company_id__companies.id', 'companies', 'name_en', 'snapshot', true),
    ('orders.seller.tax_id', 'orders', 'seller_company_id', 'orders.seller_company_id__companies.id', 'companies', 'tax_id', 'snapshot', true),
    ('orders.seller.address', 'orders', 'seller_company_id', 'orders.seller_company_id__companies.id', 'companies', 'address', 'snapshot', true),
    ('orders.buyer.name_cn', 'orders', 'buyer_company_id', 'orders.buyer_company_id__companies.id', 'companies', 'name_cn', 'snapshot', true),
    ('orders.buyer.name_en', 'orders', 'buyer_company_id', 'orders.buyer_company_id__companies.id', 'companies', 'name_en', 'snapshot', true),
    ('orders.buyer.tax_id', 'orders', 'buyer_company_id', 'orders.buyer_company_id__companies.id', 'companies', 'tax_id', 'snapshot', true),
    ('orders.buyer.address', 'orders', 'buyer_company_id', 'orders.buyer_company_id__companies.id', 'companies', 'address', 'snapshot', true),
    ('orders.factory.name_cn', 'orders', 'factory_company_id', 'orders.factory_company_id__companies.id', 'companies', 'name_cn', 'snapshot', true),
    ('orders.factory.name_en', 'orders', 'factory_company_id', 'orders.factory_company_id__companies.id', 'companies', 'name_en', 'snapshot', true),
    ('orders.factory.tax_id', 'orders', 'factory_company_id', 'orders.factory_company_id__companies.id', 'companies', 'tax_id', 'snapshot', true),
    ('orders.factory.address', 'orders', 'factory_company_id', 'orders.factory_company_id__companies.id', 'companies', 'address', 'snapshot', true)
)
UPDATE field_lookups fl
SET module_key = lookup.module_key,
    target_field_key = lookup.target_field_key,
    relation_key = lookup.relation_key,
    related_module = lookup.related_module,
    related_field_key = lookup.related_field_key,
    mode = lookup.mode,
    is_readonly = lookup.is_readonly,
    status = 'active'
FROM lookup
JOIN information_schema.columns rc
  ON rc.table_schema = 'public'
 AND rc.table_name = lookup.related_module
 AND rc.column_name = lookup.related_field_key
WHERE fl.lookup_key = lookup.lookup_key;

WITH lookup(lookup_key, module_key, target_field_key, relation_key, related_module, related_field_key, mode, is_readonly) AS (
  VALUES
    ('orders.seller.name_cn', 'orders', 'seller_company_id', 'orders.seller_company_id__companies.id', 'companies', 'name_cn', 'snapshot', true),
    ('orders.seller.name_en', 'orders', 'seller_company_id', 'orders.seller_company_id__companies.id', 'companies', 'name_en', 'snapshot', true),
    ('orders.seller.tax_id', 'orders', 'seller_company_id', 'orders.seller_company_id__companies.id', 'companies', 'tax_id', 'snapshot', true),
    ('orders.seller.address', 'orders', 'seller_company_id', 'orders.seller_company_id__companies.id', 'companies', 'address', 'snapshot', true),
    ('orders.buyer.name_cn', 'orders', 'buyer_company_id', 'orders.buyer_company_id__companies.id', 'companies', 'name_cn', 'snapshot', true),
    ('orders.buyer.name_en', 'orders', 'buyer_company_id', 'orders.buyer_company_id__companies.id', 'companies', 'name_en', 'snapshot', true),
    ('orders.buyer.tax_id', 'orders', 'buyer_company_id', 'orders.buyer_company_id__companies.id', 'companies', 'tax_id', 'snapshot', true),
    ('orders.buyer.address', 'orders', 'buyer_company_id', 'orders.buyer_company_id__companies.id', 'companies', 'address', 'snapshot', true),
    ('orders.factory.name_cn', 'orders', 'factory_company_id', 'orders.factory_company_id__companies.id', 'companies', 'name_cn', 'snapshot', true),
    ('orders.factory.name_en', 'orders', 'factory_company_id', 'orders.factory_company_id__companies.id', 'companies', 'name_en', 'snapshot', true),
    ('orders.factory.tax_id', 'orders', 'factory_company_id', 'orders.factory_company_id__companies.id', 'companies', 'tax_id', 'snapshot', true),
    ('orders.factory.address', 'orders', 'factory_company_id', 'orders.factory_company_id__companies.id', 'companies', 'address', 'snapshot', true)
)
INSERT INTO field_lookups (
  lookup_key, module_key, target_field_key, relation_key,
  related_module, related_field_key, mode, is_readonly, status
)
SELECT
  lookup.lookup_key, lookup.module_key, lookup.target_field_key, lookup.relation_key,
  lookup.related_module, lookup.related_field_key, lookup.mode, lookup.is_readonly, 'active'
FROM lookup
JOIN information_schema.columns rc
  ON rc.table_schema = 'public'
 AND rc.table_name = lookup.related_module
 AND rc.column_name = lookup.related_field_key
WHERE NOT EXISTS (
  SELECT 1 FROM field_lookups fl WHERE fl.lookup_key = lookup.lookup_key
);

-- ---------------------------------------------------------------------
-- Reports produced before rollback.
-- ---------------------------------------------------------------------
SELECT 'M036 coverage after dry-run' AS report,
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

SELECT 'M036 unresolved orders' AS report,
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

SELECT 'M1b customers missing from companies' AS report,
       cu.company_code,
       cu.name_cn,
       cu.name_en,
       cu.role_type,
       CASE
         WHEN cu.company_code IS NULL OR btrim(cu.company_code) = '' THEN 'missing customer company_code'
         WHEN c.id IS NULL THEN 'customer code absent from companies; classify real entity vs department/portal identity before insert'
         WHEN NULLIF(btrim(c.tax_id), '') IS NULL THEN 'company exists but tax_id missing; needs tianyancha/customer evidence'
       END AS action_needed
FROM customers cu
LEFT JOIN companies c ON c.code = cu.company_code
WHERE c.id IS NULL OR NULLIF(btrim(c.tax_id), '') IS NULL
ORDER BY cu.company_code;

SELECT 'M5 product link gaps' AS report,
       count(*) AS oli_total,
       count(product_id) AS oli_with_product_id,
       count(*) FILTER (WHERE product_id IS NULL) AS oli_missing_product_id
FROM order_line_items;

SELECT 'M5 duplicate SKU ambiguity' AS report,
       sku,
       count(*) AS product_rows
FROM products
WHERE NULLIF(btrim(sku), '') IS NOT NULL
GROUP BY sku
HAVING count(*) > 1
ORDER BY count(*) DESC, sku;

SELECT 'M6 text snapshot columns still present' AS report,
       table_name,
       column_name,
       'keep column, make write path use *_company_id/product_id only' AS required_code_change
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'orders'
  AND column_name IN ('customer','factory','issuing_company','issuing_company_en','company_name_cn','company_name_en','seller_code','factory_code','company_code')
ORDER BY column_name;

ROLLBACK;
