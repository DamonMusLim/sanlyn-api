-- 2026-09-27: pet store staff reception, grooming report photos, pet notes.
-- Idempotent only; no data rewrite and no deployment side effect.

BEGIN;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS reception_status text,
  ADD COLUMN IF NOT EXISTS reception_operator_id integer,
  ADD COLUMN IF NOT EXISTS reception_operator_name text,
  ADD COLUMN IF NOT EXISTS checkin_at timestamptz,
  ADD COLUMN IF NOT EXISTS start_at_actual timestamptz,
  ADD COLUMN IF NOT EXISTS finish_at timestamptz,
  ADD COLUMN IF NOT EXISTS picked_up_at timestamptz;

ALTER TABLE grooming_reports
  ADD COLUMN IF NOT EXISTS before_photos jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS after_photos jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS checks jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS owner_message text,
  ADD COLUMN IF NOT EXISTS share_text text;

ALTER TABLE pet_profiles
  ADD COLUMN IF NOT EXISTS weight_kg numeric,
  ADD COLUMN IF NOT EXISTS allergy_note text;

CREATE TABLE IF NOT EXISTS petstore_pet_notes (
  id bigserial PRIMARY KEY,
  store_code text NOT NULL,
  pet_id bigint NOT NULL,
  note_type text NOT NULL,
  title text NOT NULL,
  body text,
  source_ref text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_petstore_pet_notes_source
  ON petstore_pet_notes(store_code, pet_id, note_type, source_ref, title);

CREATE INDEX IF NOT EXISTS ix_appointments_reception_day
  ON appointments(store_code, start_at, reception_status);

COMMIT;

-- Rollback plan, manual only:
-- BEGIN;
-- DROP INDEX IF EXISTS ix_appointments_reception_day;
-- DROP INDEX IF EXISTS ux_petstore_pet_notes_source;
-- DROP TABLE IF EXISTS petstore_pet_notes;
-- ALTER TABLE pet_profiles DROP COLUMN IF EXISTS allergy_note, DROP COLUMN IF EXISTS weight_kg;
-- ALTER TABLE grooming_reports
--   DROP COLUMN IF EXISTS share_text,
--   DROP COLUMN IF EXISTS owner_message,
--   DROP COLUMN IF EXISTS checks,
--   DROP COLUMN IF EXISTS after_photos,
--   DROP COLUMN IF EXISTS before_photos;
-- ALTER TABLE appointments
--   DROP COLUMN IF EXISTS picked_up_at,
--   DROP COLUMN IF EXISTS finish_at,
--   DROP COLUMN IF EXISTS start_at_actual,
--   DROP COLUMN IF EXISTS checkin_at,
--   DROP COLUMN IF EXISTS reception_operator_name,
--   DROP COLUMN IF EXISTS reception_operator_id,
--   DROP COLUMN IF EXISTS reception_status;
-- COMMIT;
