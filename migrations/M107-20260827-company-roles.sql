-- M107: company_roles capability table.
-- Role here means company capability/qualification, not the role of a shipment.
-- Per-shipment forwarder remains derived from freight_supplier_bills.supplier;
-- shipping_plans.forwarder_cn is only a fallback.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM companies
    WHERE NULLIF(btrim(type), '') IS NOT NULL
      AND type NOT IN (
        'customer',
        'factory',
        'trader',
        'sanlyn_entity',
        'supply_chain',
        'forwarder',
        'trucking',
        'customs_broker',
        'carrier',
        'insurance'
      )
  ) THEN
    RAISE EXCEPTION 'companies.type contains values outside company_roles.role domain';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS company_roles (
  id BIGSERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id),
  role TEXT NOT NULL CHECK (
    role IN (
      'customer',
      'factory',
      'trader',
      'sanlyn_entity',
      'supply_chain',
      'forwarder',
      'trucking',
      'customs_broker',
      'carrier',
      'insurance'
    )
  ),
  is_active BOOLEAN NOT NULL DEFAULT true,
  source TEXT NOT NULL CHECK (source IN ('manual', 'derived_from_bill', 'migrated')),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  UNIQUE (company_id, role)
);

COMMENT ON TABLE company_roles IS
  'Company capability/qualification roles. Does not override per-shipment role derivation from bills.';
COMMENT ON COLUMN company_roles.role IS
  'Capability role only; shipment forwarder is still derived from freight_supplier_bills.supplier.';
COMMENT ON COLUMN company_roles.source IS
  'manual=human-entered, derived_from_bill=inferred from supplier bill history, migrated=from companies.type.';

CREATE INDEX IF NOT EXISTS idx_company_roles_role_active
  ON company_roles (role, is_active);

INSERT INTO company_roles (company_id, role, is_active, source, note, created_by)
SELECT
  id,
  type,
  COALESCE(active, true),
  'migrated',
  'Migrated from companies.type on 2026-08-27; companies.type retained for legacy queries.',
  'migration:M107'
FROM companies
WHERE NULLIF(btrim(type), '') IS NOT NULL
ON CONFLICT (company_id, role) DO NOTHING;

INSERT INTO company_roles (company_id, role, is_active, source, note, created_by)
SELECT
  c.id,
  v.role,
  true,
  'manual',
  '0827 微信依据: 拖车 2200/40HC、报关 100/票、海运港杂已在做。',
  'migration:M107'
FROM companies c
CROSS JOIN (
  VALUES
    ('forwarder'),
    ('trucking'),
    ('customs_broker')
) AS v(role)
WHERE c.code = 'CN-00084'
ON CONFLICT (company_id, role) DO UPDATE
SET
  is_active = EXCLUDED.is_active,
  source = EXCLUDED.source,
  note = EXCLUDED.note,
  updated_at = now(),
  created_by = COALESCE(company_roles.created_by, EXCLUDED.created_by);
