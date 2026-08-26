-- Manual-reviewed M104 candidate: normalize purchased service items.
-- Reason for handoff: current sandbox cannot reach Postgres information_schema.
-- Existing shipping_plans columns are true recorded facts; this only copies selected services.
-- insurance_required=false means explicitly not selected and must not create a purchased service row.

ALTER TABLE order_services
  ADD COLUMN IF NOT EXISTS plan_id bigint,
  ADD COLUMN IF NOT EXISTS bl_no text,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'explicit',
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'order_services'::regclass
       AND conname = 'order_services_source_chk'
  ) THEN
    ALTER TABLE order_services
      ADD CONSTRAINT order_services_source_chk
      CHECK (source IN ('explicit', 'migrated_from_column'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_order_services_plan_service
  ON order_services (plan_id, service_type)
  WHERE plan_id IS NOT NULL;

INSERT INTO order_services (plan_id, bl_no, service_type, source, created_at, updated_at)
SELECT sp.id, sp.bl_no, svc.service_type, 'migrated_from_column', now(), now()
  FROM shipping_plans sp
 CROSS JOIN LATERAL (
   VALUES
     ('TRUCKING', sp.trucking_arrange IS NOT NULL AND btrim(sp.trucking_arrange::text) <> ''),
     ('CUSTOMS', sp.customs_arrange IS NOT NULL AND btrim(sp.customs_arrange::text) <> ''),
     ('INSURANCE', sp.insurance_required IS TRUE)
 ) AS svc(service_type, has_value)
 WHERE sp.deleted_at IS NULL
   AND svc.has_value
ON CONFLICT (plan_id, service_type) WHERE plan_id IS NOT NULL
DO UPDATE SET
  bl_no = COALESCE(order_services.bl_no, EXCLUDED.bl_no),
  updated_at = now();
