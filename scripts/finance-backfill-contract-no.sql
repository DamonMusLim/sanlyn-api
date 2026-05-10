-- ═══════════════════════════════════════════════════════════════════
-- finance-backfill-contract-no.sql
-- Link finance_payments rows to their canonical contract_no (= orders._id).
--
-- Problem:
--   Most finance_payments have order_no (e.g. '40-CA-1') but contract_no = NULL.
--   The reconciliation API (GET /api/db/reconciliation) matches payments to
--   orders via contract_no only → payments invisible in reconciliation view.
--
-- Fix: JOIN finance_payments.order_no → orders.order_no → copy orders._id
--      into finance_payments.contract_no where currently null.
--
-- Also handles comma-separated multi-order_no rows (e.g. 'XM-254,XM-256'):
--   → split by comma, match first hit, set contract_no to that order's _id
--   (the reconciliation UI will display the payment on the first matched order;
--    a proper multi-order payment table is a P2 follow-up).
--
-- Run PREVIEW section first, then flip ROLLBACK → COMMIT.
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Simple 1:1 match (no commas) ──────────────────────────────
UPDATE finance_payments fp
SET    contract_no = o._id,
       updated_at  = NOW()
FROM   orders o
WHERE  fp.order_no = o.order_no
  AND  fp.order_no IS NOT NULL AND fp.order_no != ''
  AND  fp.order_no NOT LIKE '%,%'
  AND  (fp.contract_no IS NULL OR fp.contract_no = '');

-- ── 2. Multi-order rows: take first matching order ────────────────
-- Splits 'XM-254,XM-256' → tries 'XM-254' first
UPDATE finance_payments fp
SET    contract_no = (
         SELECT o._id
         FROM   orders o
         WHERE  o.order_no = TRIM(SPLIT_PART(fp.order_no, ',', 1))
         LIMIT 1
       ),
       updated_at = NOW()
WHERE  fp.order_no LIKE '%,%'
  AND  (fp.contract_no IS NULL OR fp.contract_no = '');

-- ── 3. Preview results ────────────────────────────────────────────
SELECT
  CASE
    WHEN contract_no IS NULL OR contract_no = '' THEN 'still_unlinked'
    ELSE 'linked'
  END                  AS link_status,
  COUNT(*)             AS cnt,
  SUM(amount)          AS total_amount
FROM finance_payments
GROUP BY 1
ORDER BY cnt DESC;

-- Linked rows will now show up in GET /api/db/reconciliation.
-- still_unlinked rows are old JDY-era orders (BB20231201 etc.) with no
-- matching order in the orders table — these are pre-platform legacy data.

-- ── 4. Spot-check: show linked payments with their order status ───
SELECT
  fp.id,
  fp.order_no        AS fp_order_no,
  fp.contract_no     AS fp_contract_no,
  fp.amount,
  fp.direction,
  o.status           AS order_status,
  o.customer_amount  AS order_customer_amount
FROM finance_payments fp
JOIN orders o ON o._id = fp.contract_no
ORDER BY fp.id
LIMIT 30;

-- ── Flip ROLLBACK → COMMIT when verified ─────────────────────────
ROLLBACK;
-- COMMIT;
