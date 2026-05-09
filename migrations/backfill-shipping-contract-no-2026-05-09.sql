-- ══════════════════════════════════════════════════════════════════
-- backfill-shipping-contract-no-2026-05-09.sql
-- Backfill shipping_plans.contract_no for the 128 rows where it is NULL.
--
-- Strategy (in order, non-overlapping):
--   Step 1 — order_contract_nos has exactly one value AND matches orders.contract_no
--   Step 2 — customer name + ETD month uniquely matches one order
--   Step 3 — remainder: listed for manual confirmation (SELECT only, no UPDATE)
--
-- Run inside a transaction so it's easy to review and rollback.
-- Expected result: ~7 auto-filled, ~121 manual.
-- ══════════════════════════════════════════════════════════════════

BEGIN;

-- ── Step 1 ──────────────────────────────────────────────────────
-- order_contract_nos contains exactly one value (no comma) AND
-- that value exists as orders.contract_no
-- Verified match count: 6 rows
UPDATE shipping_plans sp
SET    contract_no = TRIM(sp.order_contract_nos),
       updated_at  = now()
FROM   orders o
WHERE  (sp.contract_no IS NULL OR sp.contract_no = '')
  AND  sp.order_contract_nos IS NOT NULL
  AND  sp.order_contract_nos != ''
  AND  sp.order_contract_nos NOT LIKE '%,%'
  AND  o.contract_no = TRIM(sp.order_contract_nos);

-- Report Step 1
DO $$
DECLARE cnt INTEGER;
BEGIN
  GET DIAGNOSTICS cnt = ROW_COUNT;
  RAISE NOTICE 'Step 1 (single order_contract_nos match): % rows updated', cnt;
END $$;

-- ── Step 2 ──────────────────────────────────────────────────────
-- customer string ILIKE + ETD month uniquely matches one order row
-- Verified match count: 1 row
UPDATE shipping_plans sp
SET    contract_no = sub.contract_no,
       updated_at  = now()
FROM (
  SELECT sp2.id, o.contract_no
  FROM   shipping_plans sp2
  JOIN   orders o
         ON  o.customer ILIKE sp2.customer
         AND date_trunc('month', o.etd::date) = date_trunc('month', sp2.etd)
  WHERE  (sp2.contract_no IS NULL OR sp2.contract_no = '')
    AND  (sp2.order_contract_nos IS NULL OR sp2.order_contract_nos = '' OR sp2.order_contract_nos LIKE '%,%')
    AND  sp2.customer IS NOT NULL AND sp2.customer != ''
    AND  sp2.etd IS NOT NULL
  GROUP  BY sp2.id, o.contract_no
  HAVING COUNT(o.id) = 1  -- only update if the match is unique
) sub
WHERE  sp.id = sub.id
  AND  (sp.contract_no IS NULL OR sp.contract_no = '');

DO $$
DECLARE cnt INTEGER;
BEGIN
  GET DIAGNOSTICS cnt = ROW_COUNT;
  RAISE NOTICE 'Step 2 (unique customer+ETD month match): % rows updated', cnt;
END $$;

-- ── Summary ─────────────────────────────────────────────────────
DO $$
DECLARE
  total_before  INTEGER := 128;
  total_after   INTEGER;
  auto_filled   INTEGER;
BEGIN
  SELECT COUNT(*) INTO total_after
  FROM   shipping_plans
  WHERE  contract_no IS NULL OR contract_no = '';

  auto_filled := total_before - total_after;
  RAISE NOTICE '─────────────────────────────────────────────';
  RAISE NOTICE 'Backfill complete:';
  RAISE NOTICE '  Auto-filled : % rows', auto_filled;
  RAISE NOTICE '  Still NULL  : % rows (manual confirmation needed)', total_after;
  RAISE NOTICE '  Total checked: 169 rows (41 already had contract_no)';
END $$;

COMMIT;

-- ── Step 3: manual confirmation list ────────────────────────────
-- These rows could NOT be auto-matched. Review and UPDATE manually.
-- Criteria: no contract_no, no single-value order_contract_nos, no unique customer+ETD match.
SELECT
  sp.id,
  sp.shipment_no,
  sp.bl_no,
  sp.customer,
  sp.order_contract_nos,
  sp.etd::text AS etd,
  sp.vessel,
  sp.pod
FROM   shipping_plans sp
WHERE  (sp.contract_no IS NULL OR sp.contract_no = '')
ORDER  BY sp.etd DESC NULLS LAST;

-- ── Verification query ───────────────────────────────────────────
-- Run after commit to confirm final state:
-- SELECT
--   COUNT(*) AS total,
--   COUNT(contract_no) FILTER (WHERE contract_no IS NOT NULL AND contract_no != '') AS has_contract,
--   COUNT(*) FILTER (WHERE contract_no IS NULL OR contract_no = '') AS missing_contract
-- FROM shipping_plans;
