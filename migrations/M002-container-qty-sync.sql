-- M002: container_qty sync from container_bookings
-- Idempotent: only updates where actual count differs from stored value.
-- Run: psql -h 127.0.0.1 -U sanlyn_admin -d sanlyn_db -f M002-container-qty-sync.sql

BEGIN;

-- Preview before change
SELECT
  sp.id,
  sp.shipment_no,
  sp.container_qty AS current_qty,
  COUNT(cb.id) AS actual_cnt
FROM shipping_plans sp
JOIN container_bookings cb ON cb.shipping_plan_id = sp.id
GROUP BY sp.id, sp.shipment_no, sp.container_qty
HAVING sp.container_qty IS NULL OR sp.container_qty != COUNT(cb.id)
ORDER BY sp.id;

-- Update container_qty to match actual bookings count
UPDATE shipping_plans sp
SET container_qty = sub.actual_cnt
FROM (
  SELECT shipping_plan_id, COUNT(*) AS actual_cnt
  FROM container_bookings
  GROUP BY shipping_plan_id
) sub
WHERE sp.id = sub.shipping_plan_id
  AND (sp.container_qty IS NULL OR sp.container_qty != sub.actual_cnt);

SELECT 'container_qty synced: ' || ROW_COUNT() || ' rows updated' AS result;

-- Verify
SELECT
  COUNT(*) AS total_plans_with_bookings,
  COUNT(CASE WHEN sp.container_qty = sub.actual_cnt THEN 1 END) AS correctly_synced
FROM shipping_plans sp
JOIN (
  SELECT shipping_plan_id, COUNT(*) AS actual_cnt
  FROM container_bookings
  GROUP BY shipping_plan_id
) sub ON sp.id = sub.shipping_plan_id;

COMMIT;
