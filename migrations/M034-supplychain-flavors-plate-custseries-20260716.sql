-- 供应链协同 2026-07-16 归档(已apply腾讯,此为canonical存档)
ALTER TABLE packaging_materials ADD COLUMN IF NOT EXISTS flavors JSONB DEFAULT '[]'::jsonb;
ALTER TABLE packaging_materials ADD COLUMN IF NOT EXISTS plate_status TEXT;
ALTER TABLE packaging_materials ADD COLUMN IF NOT EXISTS plate_uploaded_at TIMESTAMPTZ;
ALTER TABLE packaging_materials ADD COLUMN IF NOT EXISTS plate_nas_location TEXT;
ALTER TABLE packaging_materials ADD COLUMN IF NOT EXISTS plate_archived_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS customer_series (
  id BIGSERIAL PRIMARY KEY, customer_code TEXT NOT NULL, series_name TEXT NOT NULL,
  flavors JSONB NOT NULL DEFAULT '[]'::jsonb, note TEXT, status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_by TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS customer_series_uniq ON customer_series(customer_code, series_name) WHERE status <> 'inactive';
CREATE INDEX IF NOT EXISTS customer_series_cust ON customer_series(customer_code);
