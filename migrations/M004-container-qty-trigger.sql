-- M004: Auto-sync container_qty trigger on container_bookings changes
-- Idempotent: uses CREATE OR REPLACE + DROP TRIGGER IF EXISTS.
-- Run: psql -h 127.0.0.1 -U sanlyn_admin -d sanlyn_db -f M004-container-qty-trigger.sql

CREATE OR REPLACE FUNCTION sync_container_qty()
RETURNS TRIGGER AS $$
DECLARE
  _plan_id INTEGER;
BEGIN
  _plan_id := COALESCE(NEW.shipping_plan_id, OLD.shipping_plan_id);
  IF _plan_id IS NOT NULL THEN
    UPDATE shipping_plans
    SET container_qty = (
      SELECT COUNT(*) FROM container_bookings
      WHERE shipping_plan_id = _plan_id
    )
    WHERE id = _plan_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_container_qty ON container_bookings;
CREATE TRIGGER trg_sync_container_qty
AFTER INSERT OR UPDATE OR DELETE ON container_bookings
FOR EACH ROW EXECUTE FUNCTION sync_container_qty();

SELECT 'M004: trigger trg_sync_container_qty installed on container_bookings';
