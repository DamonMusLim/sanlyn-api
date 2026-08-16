-- migrations/M079_petstore_rival_snapshots.sql

BEGIN;

CREATE TABLE IF NOT EXISTS petstore_rival_snapshots (
    id bigserial PRIMARY KEY,
    captured_at timestamptz NOT NULL DEFAULT now(),
    slot text NOT NULL CHECK (slot IN ('10:00', '12:00', '18:00', '21:00')),
    device_id text,
    screens_count int NOT NULL DEFAULT 0 CHECK (screens_count >= 0),
    status text NOT NULL CHECK (status IN ('ok', 'failed')),
    error_message text,
    image_dir text,
    extracted_count int NOT NULL DEFAULT 0 CHECK (extracted_count >= 0)
);

CREATE TABLE IF NOT EXISTS petstore_rival_store_obs (
    id bigserial PRIMARY KEY,
    snapshot_id bigint NOT NULL REFERENCES petstore_rival_snapshots(id) ON DELETE CASCADE,
    captured_at timestamptz NOT NULL,
    slot text NOT NULL CHECK (slot IN ('10:00', '12:00', '18:00', '21:00')),
    store_name text,
    is_ours boolean,
    month_sales_text text,
    min_order numeric,
    delivery_fee_text text,
    rating text,
    distance_text text,
    eta_text text,
    promos jsonb NOT NULL DEFAULT '[]'::jsonb,
    subsidy_self numeric,
    raw_line text
);

CREATE INDEX IF NOT EXISTS idx_petstore_rival_store_obs_store_captured
    ON petstore_rival_store_obs (store_name, captured_at);

CREATE INDEX IF NOT EXISTS idx_petstore_rival_store_obs_slot_captured
    ON petstore_rival_store_obs (slot, captured_at);

COMMIT;
