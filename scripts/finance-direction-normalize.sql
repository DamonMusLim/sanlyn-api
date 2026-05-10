-- ═══════════════════════════════════════════════════════════════════
-- finance-direction-normalize.sql
-- Normalize finance_payments.direction to canonical AR / AP values.
--
-- Current chaos:
--   263 rows  direction = '' (empty string)
--   75  rows  direction = '收款'   → AR  (customer pays Sanlyn)
--   46  rows  direction = '付款'   → AP  (Sanlyn pays vendor/factory)
--   1   row   direction = 'in'     → AR
--   1   row   direction = 'out'    → AP
--
-- Business rule (FIN-FIX-ARAP-SETTLEMENT-001 / F1):
--   AR = Accounts Receivable  = money COMING IN  from customer
--   AP = Accounts Payable     = money GOING  OUT to supplier / freight
--
-- Empty-string rows: most have customer_en set and amount matches order's
-- customer_amount → treat as AR.  Rows with pay_item like '付款' are AP.
-- The logic below is conservative: empty + has customer_en → AR,
-- empty + pay_item ILIKE '%付%' → AP.  Run SELECT preview first.
--
-- SAFE: wrapped in BEGIN/ROLLBACK.  Review SELECTs, then flip to COMMIT.
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Canonical renames for already-labelled rows ────────────────
UPDATE finance_payments SET direction = 'AR' WHERE direction IN ('收款', 'in');
UPDATE finance_payments SET direction = 'AP' WHERE direction IN ('付款', 'out');

-- ── 2. Empty-string rows: classify by context ─────────────────────
-- 2a. Has customer_en (= customer paying Sanlyn) AND no AP signal → AR
UPDATE finance_payments
SET    direction = 'AR'
WHERE  (direction IS NULL OR direction = '')
  AND  customer_en IS NOT NULL AND customer_en != ''
  AND  (pay_item IS NULL OR pay_item NOT ILIKE '%付%');

-- 2b. Remaining empty rows where pay_item contains '付' → AP
UPDATE finance_payments
SET    direction = 'AP'
WHERE  (direction IS NULL OR direction = '')
  AND  pay_item ILIKE '%付%';

-- 2c. Any still-empty rows: default AR (conservative — visible in AR tab)
UPDATE finance_payments
SET    direction = 'AR'
WHERE  direction IS NULL OR direction = '';

-- ── 3. Verification ───────────────────────────────────────────────
SELECT
  direction,
  COUNT(*)           AS cnt,
  SUM(amount)        AS total_amount,
  MIN(payment_date)  AS earliest,
  MAX(payment_date)  AS latest
FROM finance_payments
GROUP BY direction
ORDER BY cnt DESC;

-- Expected after commit:
--   AR  | ~340 rows | ~69M CNY
--   AP  | ~46  rows | ~1.4M CNY

-- ── Flip ROLLBACK → COMMIT when verified ─────────────────────────
ROLLBACK;
-- COMMIT;
