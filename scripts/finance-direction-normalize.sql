-- ═══════════════════════════════════════════════════════════════════
-- finance-direction-normalize.sql · DRY-RUN ONLY (FIN-FIX-ARAP-001)
--
-- ⚠️  DO NOT COMMIT THIS UNTIL HUMAN HAS REVIEWED THE PER-ROW DETAIL.
--     Codex feedback 2026-05-11: 263 行空 direction 不能直接默认 AR.
--     必须先输出 dry-run 明细，确认没有 AP 误归类后再放行。
--
-- This file ONLY does SELECTs. The UPDATE block is commented out.
-- Workflow:
--   1. psql -f finance-direction-normalize.sql > out.txt
--   2. Review out.txt section by section
--   3. Manually run the UPDATE block (uncomment + wrap in BEGIN/COMMIT)
-- ═══════════════════════════════════════════════════════════════════

-- ── A. Distribution snapshot ─────────────────────────────────────
SELECT '── A. Current direction distribution ──' AS section;
SELECT
  COALESCE(direction, '(null)') AS direction,
  COUNT(*) AS cnt,
  ROUND(SUM(amount)::numeric, 2) AS total_amount,
  string_agg(DISTINCT currency, '/') AS currencies
FROM finance_payments
GROUP BY direction
ORDER BY cnt DESC;

-- ── B. Per-currency breakdown of empty-direction rows ────────────
SELECT '── B. Empty-direction rows by currency ──' AS section;
SELECT
  COALESCE(currency,'(null)') AS currency,
  COUNT(*) AS cnt,
  COUNT(*) FILTER (WHERE amount IS NULL) AS rows_with_null_amount,
  ROUND(SUM(amount)::numeric, 2) AS total_amount,
  COUNT(DISTINCT customer_en) AS distinct_counterparties
FROM finance_payments
WHERE direction IS NULL OR direction = ''
GROUP BY currency
ORDER BY cnt DESC;

-- ── C. Inference signal counts (no AP rule yet — be paranoid) ─────
SELECT '── C. Inference signal distribution ──' AS section;
SELECT
  CASE
    WHEN pay_item ILIKE '%付%' OR pay_item ILIKE '%pay%'
      THEN 'AP_signal: pay_item contains 付/pay'
    WHEN forwarder_cn IS NOT NULL AND forwarder_cn != ''
      THEN 'AP_signal: has forwarder_cn (= we paid forwarder)'
    WHEN customer_en IS NOT NULL AND customer_en != ''
       AND amount IS NOT NULL AND amount > 0
       AND order_no IS NOT NULL AND order_no != ''
      THEN 'AR_signal: has customer_en + amount + order_no'
    WHEN customer_en IS NOT NULL AND customer_en != ''
       AND (amount IS NULL OR order_no IS NULL OR order_no = '')
      THEN 'AMBIGUOUS: customer_en set but missing amount or order_no'
    ELSE 'NO_SIGNAL: empty stub row'
  END AS classification,
  COUNT(*) AS cnt,
  ROUND(SUM(amount)::numeric, 2) AS total
FROM finance_payments
WHERE direction IS NULL OR direction = ''
GROUP BY 1
ORDER BY cnt DESC;

-- ── D. AP signal rows — full detail (must be reviewed manually) ───
SELECT '── D. AP-signal rows (must review) ──' AS section;
SELECT
  id, amount, currency,
  COALESCE(NULLIF(contract_no,''), '—')   AS contract_no,
  COALESCE(NULLIF(order_no,''),    '—')   AS order_no,
  COALESCE(NULLIF(pay_type,''),    '—')   AS pay_type,
  COALESCE(NULLIF(pay_item,''),    '—')   AS pay_item,
  COALESCE(NULLIF(customer_en,''), '—')   AS customer_en,
  COALESCE(NULLIF(forwarder_cn,''),'—')   AS forwarder_cn,
  COALESCE(NULLIF(issuing_co,''),  '—')   AS issuing_co,
  raw->>'note'                            AS note
FROM finance_payments
WHERE (direction IS NULL OR direction = '')
  AND ( pay_item ILIKE '%付%'
     OR pay_item ILIKE '%pay%'
     OR (forwarder_cn IS NOT NULL AND forwarder_cn != '') )
ORDER BY amount DESC NULLS LAST;

-- ── E. Ambiguous rows (must review) ──────────────────────────────
SELECT '── E. Ambiguous rows (customer_en set but missing data) ──' AS section;
SELECT
  id, amount, currency,
  COALESCE(NULLIF(contract_no,''), '—')   AS contract_no,
  COALESCE(NULLIF(order_no,''),    '—')   AS order_no,
  COALESCE(NULLIF(pay_type,''),    '—')   AS pay_type,
  COALESCE(NULLIF(pay_item,''),    '—')   AS pay_item,
  COALESCE(NULLIF(customer_en,''), '—')   AS customer_en,
  raw->>'note'                            AS note
FROM finance_payments
WHERE (direction IS NULL OR direction = '')
  AND customer_en IS NOT NULL AND customer_en != ''
  AND (amount IS NULL OR order_no IS NULL OR order_no = '')
ORDER BY amount DESC NULLS LAST;

-- ── F. NO_SIGNAL rows (empty stubs — recommend leave as-is) ───────
SELECT '── F. NO_SIGNAL rows (empty stubs) ──' AS section;
SELECT
  id, amount, currency, contract_no, order_no, pay_type,
  customer_en, raw
FROM finance_payments
WHERE (direction IS NULL OR direction = '')
  AND (customer_en IS NULL OR customer_en = '')
  AND (pay_item IS NULL OR pay_item = '')
  AND (forwarder_cn IS NULL OR forwarder_cn = '')
ORDER BY id;

-- ═══════════════════════════════════════════════════════════════════
-- UPDATE BLOCK · DO NOT EXECUTE WITHOUT HUMAN REVIEW OF SECTIONS A-F
-- ═══════════════════════════════════════════════════════════════════
--
-- Once Damon has reviewed the per-row output and confirmed:
--   1. Section D rows are genuinely AP (or have been manually re-classified)
--   2. Section E rows have been resolved (assigned direction manually)
--   3. Section F empty stubs should be left alone OR deleted
--
-- … then run this block manually:
--
-- BEGIN;
--   -- 1. Canonical renames
--   UPDATE finance_payments SET direction = 'AR' WHERE direction IN ('收款','in');
--   UPDATE finance_payments SET direction = 'AP' WHERE direction IN ('付款','out');
--
--   -- 2. Empty rows with AR signal (customer_en + amount + order_no)
--   UPDATE finance_payments
--   SET    direction = 'AR'
--   WHERE  (direction IS NULL OR direction = '')
--     AND  customer_en IS NOT NULL AND customer_en != ''
--     AND  amount IS NOT NULL AND amount > 0
--     AND  order_no  IS NOT NULL AND order_no  != ''
--     AND  (pay_item IS NULL OR pay_item = '' OR pay_item NOT ILIKE '%付%')
--     AND  (forwarder_cn IS NULL OR forwarder_cn = '');
--
--   -- 3. AP-signal rows (already reviewed in section D — confirm before running)
--   --    Only run if section D output has been audited!
--   -- UPDATE finance_payments
--   -- SET    direction = 'AP'
--   -- WHERE  (direction IS NULL OR direction = '')
--   --   AND  ( pay_item ILIKE '%付%' OR (forwarder_cn IS NOT NULL AND forwarder_cn != '') );
--
--   -- 4. Verification
--   SELECT direction, currency, COUNT(*), ROUND(SUM(amount)::numeric, 2)
--   FROM finance_payments GROUP BY direction, currency ORDER BY direction, currency;
--
-- ROLLBACK;  -- flip to COMMIT only when sums match expectation
-- ═══════════════════════════════════════════════════════════════════
