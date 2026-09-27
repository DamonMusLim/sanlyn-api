-- M126: staff stock mismatch reports. Staff never writes POS stock here.

CREATE TABLE IF NOT EXISTS petstore_stock_reports (
  id BIGSERIAL PRIMARY KEY,
  company_code TEXT NOT NULL,
  product_code TEXT NOT NULL,
  barcode TEXT,
  product_name TEXT,
  bound_location TEXT,
  system_qty NUMERIC(12,2),
  actual_qty NUMERIC(12,2),
  reason TEXT NOT NULL,
  photos JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'searching',
  found_location TEXT,
  found_action TEXT,
  found_photos JSONB NOT NULL DEFAULT '[]'::jsonb,
  reported_by_employee_id INTEGER NOT NULL,
  reported_by_name TEXT,
  shift_note TEXT,
  is_frequent_lost BOOLEAN NOT NULL DEFAULT false,
  confirmed_loss_qty NUMERIC(12,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  found_at TIMESTAMPTZ,
  confirmed_by TEXT,
  confirmed_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  CONSTRAINT petstore_stock_reports_reason_chk CHECK (
    reason IN ('missing','wrong_location','not_received','damaged_expired','unknown')
  ),
  CONSTRAINT petstore_stock_reports_status_chk CHECK (
    status IN ('searching','pending_confirm','found','confirmed_lost')
  ),
  CONSTRAINT petstore_stock_reports_found_action_chk CHECK (
    found_action IS NULL OR found_action IN ('return_bound','rebind_new')
  )
);

CREATE INDEX IF NOT EXISTS idx_petstore_stock_reports_company_status_created
  ON petstore_stock_reports(company_code, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_petstore_stock_reports_product_created
  ON petstore_stock_reports(product_code, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_petstore_stock_reports_employee_created
  ON petstore_stock_reports(reported_by_employee_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS ux_petstore_stock_reports_open_product_employee
  ON petstore_stock_reports(company_code, product_code, reported_by_employee_id)
  WHERE status IN ('searching','pending_confirm');

ALTER TABLE petstore_stock_reports
  ADD COLUMN IF NOT EXISTS found_photos JSONB NOT NULL DEFAULT '[]'::jsonb;
