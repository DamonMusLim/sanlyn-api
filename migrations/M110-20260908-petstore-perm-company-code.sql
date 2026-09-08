-- R16: petstore permission tenant isolation + DACO disabled area-manager accounts.
-- Run on production PG before deploying patched petstore-perm-* handlers.
-- Required preflight output is produced by the SELECT statements below.

BEGIN;

ALTER TABLE petstore_roles ADD COLUMN IF NOT EXISTS company_code text;
ALTER TABLE petstore_account_profile ADD COLUMN IF NOT EXISTS company_code text;
ALTER TABLE petstore_role_menus ADD COLUMN IF NOT EXISTS company_code text;
ALTER TABLE petstore_account_stores ADD COLUMN IF NOT EXISTS company_code text;

SELECT 'dry_run_before_backfill' AS phase, 'petstore_roles' AS table_name, count(*)::int AS rows_to_backfill
  FROM petstore_roles WHERE company_code IS NULL;
SELECT 'dry_run_before_backfill' AS phase, 'petstore_account_profile' AS table_name, count(*)::int AS rows_to_backfill
  FROM petstore_account_profile WHERE company_code IS NULL;
SELECT 'dry_run_before_backfill' AS phase, 'petstore_role_menus' AS table_name, count(*)::int AS rows_to_backfill
  FROM petstore_role_menus WHERE company_code IS NULL;
SELECT 'dry_run_before_backfill' AS phase, 'petstore_account_stores' AS table_name, count(*)::int AS rows_to_backfill
  FROM petstore_account_stores WHERE company_code IS NULL;

SELECT conname, pg_get_constraintdef(c.oid) AS constraint_def
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
 WHERE t.relname = 'petstore_roles'
   AND c.contype = 'u'
 ORDER BY conname;

UPDATE petstore_roles SET company_code = 'LUVSOME' WHERE company_code IS NULL;
UPDATE petstore_account_profile SET company_code = 'LUVSOME' WHERE company_code IS NULL;
UPDATE petstore_role_menus m
   SET company_code = COALESCE(r.company_code, 'LUVSOME')
  FROM petstore_roles r
 WHERE m.role_id = r.id
   AND m.company_code IS NULL;
UPDATE petstore_role_menus SET company_code = 'LUVSOME' WHERE company_code IS NULL;
UPDATE petstore_account_stores s
   SET company_code = COALESCE(a.company_code, 'LUVSOME')
  FROM accounts a
 WHERE s.account_id = a.id
   AND s.company_code IS NULL;
UPDATE petstore_account_stores SET company_code = 'LUVSOME' WHERE company_code IS NULL;

ALTER TABLE petstore_roles ALTER COLUMN company_code SET NOT NULL;
ALTER TABLE petstore_account_profile ALTER COLUMN company_code SET NOT NULL;
ALTER TABLE petstore_role_menus ALTER COLUMN company_code SET NOT NULL;
ALTER TABLE petstore_account_stores ALTER COLUMN company_code SET NOT NULL;

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY(con.conkey)
     WHERE rel.relname = 'petstore_roles'
       AND con.contype = 'u'
     GROUP BY con.conname, con.conkey
    HAVING array_agg(att.attname ORDER BY att.attnum) = ARRAY['role_key']::name[]
  LOOP
    EXECUTE format('ALTER TABLE petstore_roles DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'petstore_roles_company_role_key_key'
  ) THEN
    ALTER TABLE petstore_roles
      ADD CONSTRAINT petstore_roles_company_role_key_key UNIQUE (company_code, role_key);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_petstore_account_profile_company_account
  ON petstore_account_profile(company_code, account_id);
CREATE INDEX IF NOT EXISTS idx_petstore_role_menus_company_role
  ON petstore_role_menus(company_code, role_id);
CREATE INDEX IF NOT EXISTS idx_petstore_account_stores_company_account
  ON petstore_account_stores(company_code, account_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'petstore_roles_company_code_fkey') THEN
    ALTER TABLE petstore_roles
      ADD CONSTRAINT petstore_roles_company_code_fkey
      FOREIGN KEY (company_code) REFERENCES companies(code) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'petstore_account_profile_company_code_fkey') THEN
    ALTER TABLE petstore_account_profile
      ADD CONSTRAINT petstore_account_profile_company_code_fkey
      FOREIGN KEY (company_code) REFERENCES companies(code) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'petstore_role_menus_company_code_fkey') THEN
    ALTER TABLE petstore_role_menus
      ADD CONSTRAINT petstore_role_menus_company_code_fkey
      FOREIGN KEY (company_code) REFERENCES companies(code) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'petstore_account_stores_company_code_fkey') THEN
    ALTER TABLE petstore_account_stores
      ADD CONSTRAINT petstore_account_stores_company_code_fkey
      FOREIGN KEY (company_code) REFERENCES companies(code) NOT VALID;
  END IF;
END $$;

ALTER TABLE petstore_roles VALIDATE CONSTRAINT petstore_roles_company_code_fkey;
ALTER TABLE petstore_account_profile VALIDATE CONSTRAINT petstore_account_profile_company_code_fkey;
ALTER TABLE petstore_role_menus VALIDATE CONSTRAINT petstore_role_menus_company_code_fkey;
ALTER TABLE petstore_account_stores VALIDATE CONSTRAINT petstore_account_stores_company_code_fkey;

INSERT INTO petstore_roles (company_code, role_key, role_name, description, is_builtin, is_active, created_at, updated_at)
VALUES ('MY-00087', 'viewer', 'Viewer', 'DACO read-only report viewer', false, true, now(), now())
ON CONFLICT (company_code, role_key) DO UPDATE
  SET role_name = EXCLUDED.role_name,
      description = EXCLUDED.description,
      is_active = true,
      updated_at = now();

WITH src AS (
  SELECT m.menu_path
    FROM petstore_role_menus m
    JOIN petstore_roles r ON r.id = m.role_id
   WHERE r.company_code = 'LUVSOME'
     AND r.role_key = 'viewer'
), dst AS (
  SELECT id FROM petstore_roles WHERE company_code = 'MY-00087' AND role_key = 'viewer'
)
INSERT INTO petstore_role_menus (company_code, role_id, menu_path, can_view, can_edit)
SELECT 'MY-00087', dst.id, src.menu_path, true, false
  FROM src CROSS JOIN dst
ON CONFLICT (role_id, menu_path) DO UPDATE
  SET company_code = EXCLUDED.company_code,
      can_view = true,
      can_edit = false;

-- 语句一:只建/更新账号
INSERT INTO accounts (username, password, role, company, company_code, contact_name, is_active, raw, created_at, updated_at)
SELECT m.username, NULL, 'customer', 'DACO PETSMART SDN. BHD.', 'MY-00087', m.contact_name,
       false, jsonb_build_object('must_reset_password', true, 'r16', 'daco_area_manager'), now(), now()
  FROM (VALUES
    ('daco_sunghao', 'SUNGHAO'),
    ('daco_shader',  'SHADER'),
    ('daco_youwei',  'YOUWEI'),
    ('daco_ashley',  'ASHLEY'),
    ('daco_jacky',   'JACKY'),
    ('daco_junyou',  'JUNYOU'),
    ('daco_chris',   'CHRIS'),
    ('daco_susan',   'SUSAN'),
    ('daco_alex',    'ALEX')
  ) AS m(username, contact_name)
ON CONFLICT (username) DO UPDATE
  SET company = EXCLUDED.company,
      company_code = EXCLUDED.company_code,
      contact_name = EXCLUDED.contact_name,
      is_active = false,
      raw = COALESCE(accounts.raw, '{}'::jsonb) || EXCLUDED.raw,
      updated_at = now();

-- 语句二:账号已落库,这里才读得到
INSERT INTO petstore_account_profile (company_code, account_id, role_id, status, created_at, updated_at)
SELECT 'MY-00087', a.id, r.id, 'disabled', now(), now()
  FROM accounts a
  JOIN petstore_roles r ON r.company_code = 'MY-00087' AND r.role_key = 'viewer'
 WHERE a.company_code = 'MY-00087' AND a.username LIKE 'daco\_%'
ON CONFLICT (account_id) DO UPDATE
  SET company_code = EXCLUDED.company_code,
      role_id = EXCLUDED.role_id,
      status = 'disabled',
      updated_at = now();

WITH managers(username, stores) AS (
  VALUES
    ('daco_sunghao', ARRAY['D01','D06','D18','D27','D29','D48','D49','D62','D64']::text[]),
    ('daco_shader',  ARRAY['D02','D13','D15','D19','D21','D30','D38']::text[]),
    ('daco_youwei',  ARRAY['D04','D08','D11','D14','D22','D42','D55']::text[]),
    ('daco_ashley',  ARRAY['D07','D10','D24','D41','D52','D60','D61']::text[]),
    ('daco_jacky',   ARRAY['D05','D23','D32','D45','D54','D63']::text[]),
    ('daco_junyou',  ARRAY['D09','D20','D28','D31','D46','D53']::text[]),
    ('daco_chris',   ARRAY['D16','D33','D35','D37','D43','D51']::text[]),
    ('daco_susan',   ARRAY['D03','D17','D36','D44','D65']::text[]),
    ('daco_alex',    ARRAY['D26','D39','D50']::text[])
), account_rows AS (
  SELECT a.id AS account_id, m.stores
    FROM managers m
    JOIN accounts a ON a.username = m.username AND a.company_code = 'MY-00087'
)
INSERT INTO petstore_account_stores (company_code, account_id, store_code, is_default)
SELECT 'MY-00087', account_id, store_code, ord = 1
  FROM account_rows
 CROSS JOIN LATERAL unnest(stores) WITH ORDINALITY AS u(store_code, ord)
ON CONFLICT (account_id, store_code) DO UPDATE
  SET company_code = EXCLUDED.company_code,
      is_default = EXCLUDED.is_default;

SELECT 'after_backfill_group' AS phase, 'petstore_roles' AS table_name, company_code, count(*)::int
  FROM petstore_roles GROUP BY company_code ORDER BY company_code;
SELECT 'after_backfill_group' AS phase, 'petstore_account_profile' AS table_name, company_code, count(*)::int
  FROM petstore_account_profile GROUP BY company_code ORDER BY company_code;
SELECT 'after_backfill_group' AS phase, 'petstore_role_menus' AS table_name, company_code, count(*)::int
  FROM petstore_role_menus GROUP BY company_code ORDER BY company_code;
SELECT 'after_backfill_group' AS phase, 'petstore_account_stores' AS table_name, company_code, count(*)::int
  FROM petstore_account_stores GROUP BY company_code ORDER BY company_code;

SELECT conname, pg_get_constraintdef(c.oid) AS constraint_def
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
 WHERE t.relname = 'petstore_roles'
   AND c.contype = 'u'
 ORDER BY conname;

WITH expected(username, stores) AS (
  VALUES
    ('daco_sunghao', ARRAY['D01','D06','D18','D27','D29','D48','D49','D62','D64']::text[]),
    ('daco_shader',  ARRAY['D02','D13','D15','D19','D21','D30','D38']::text[]),
    ('daco_youwei',  ARRAY['D04','D08','D11','D14','D22','D42','D55']::text[]),
    ('daco_ashley',  ARRAY['D07','D10','D24','D41','D52','D60','D61']::text[]),
    ('daco_jacky',   ARRAY['D05','D23','D32','D45','D54','D63']::text[]),
    ('daco_junyou',  ARRAY['D09','D20','D28','D31','D46','D53']::text[]),
    ('daco_chris',   ARRAY['D16','D33','D35','D37','D43','D51']::text[]),
    ('daco_susan',   ARRAY['D03','D17','D36','D44','D65']::text[]),
    ('daco_alex',    ARRAY['D26','D39','D50']::text[])
)
SELECT a.username, r.role_key AS role,
       count(s.store_code)::int AS store_count,
       string_agg(s.store_code, ',' ORDER BY s.store_code) AS store_codes
  FROM expected e
  JOIN accounts a ON a.username = e.username
  JOIN petstore_account_profile p ON p.account_id = a.id AND p.company_code = 'MY-00087'
  JOIN petstore_roles r ON r.id = p.role_id AND r.company_code = 'MY-00087'
  LEFT JOIN petstore_account_stores s ON s.account_id = a.id AND s.company_code = 'MY-00087'
 GROUP BY a.username, r.role_key
 ORDER BY a.username;

SELECT 'daco_store_total' AS check_name, count(*)::int AS store_bindings,
       count(DISTINCT store_code)::int AS distinct_stores
  FROM petstore_account_stores s
  JOIN accounts a ON a.id = s.account_id
 WHERE a.username LIKE 'daco_%'
   AND s.company_code = 'MY-00087';

COMMIT;
