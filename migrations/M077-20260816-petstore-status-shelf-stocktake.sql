-- M077-20260816-petstore-status-shelf-stocktake.sql

CREATE TABLE IF NOT EXISTS petstore_product_status (
  product_code TEXT PRIMARY KEY,
  marker TEXT,
  note TEXT,
  updated_by_person_id BIGINT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT petstore_product_status_marker_chk
    CHECK (marker IN ('正常','临期','过期','清仓','死货','停售','价录错'))
);

CREATE TABLE IF NOT EXISTS petstore_shelf_action_intents (
  id BIGSERIAL PRIMARY KEY,
  product_code TEXT NOT NULL,
  product_name TEXT,
  action TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'proposed',
  requested_by_person_id BIGINT,
  created_at TIMESTAMPTZ DEFAULT now(),
  worker_id TEXT,
  claimed_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ,
  result TEXT,
  CONSTRAINT petstore_shelf_action_intents_action_chk
    CHECK (action IN ('LOWER','UP')),
  CONSTRAINT petstore_shelf_action_intents_status_chk
    CHECK (status IN ('proposed','approved','applying','applied','failed','cancelled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_psai_open
  ON petstore_shelf_action_intents(product_code)
  WHERE status IN ('proposed','approved','applying');

CREATE INDEX IF NOT EXISTS ix_psai_status_created
  ON petstore_shelf_action_intents(status, created_at);

ALTER TABLE petstore_stocktake
  ADD COLUMN IF NOT EXISTS reason TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS requested_by_person_id BIGINT,
  ADD COLUMN IF NOT EXISTS reviewed_by_person_id BIGINT,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS profitloss_result TEXT;

ALTER TABLE petstore_stocktake
  DROP CONSTRAINT IF EXISTS petstore_stocktake_reason_chk,
  ADD CONSTRAINT petstore_stocktake_reason_chk
    CHECK (
      reason IS NULL OR reason IN (
        'PRODUCT_DAMAGE',
        'PRODUCT_LOSE',
        'PRODUCT_EXPIRATION',
        'QUALITY_EXCEPTION',
        'INTERNAL_REQUISITION',
        'PRODUCT_EXPIRED',
        'FILL_SALE',
        'OTHER_REASON'
      )
    );

ALTER TABLE petstore_stocktake
  DROP CONSTRAINT IF EXISTS petstore_stocktake_status_chk,
  ADD CONSTRAINT petstore_stocktake_status_chk
    CHECK (status IN ('pending','approved','rejected','applied','failed'));
