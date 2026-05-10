-- ═══════════════════════════════════════════════════════════════════
-- finance-backfill-contract-no.sql · DRY-RUN ONLY
--
-- ⚠️ Codex P1-2 fix (2026-05-11):
--    EARLIER VERSION wrote orders._id (MongoDB hex) into
--    finance_payments.contract_no. That would corrupt the FS-style
--    contract_no chain that PR #5's reconciliation fix now relies on.
--
-- THIS VERSION:
--   1. Backfill ONLY uses orders.contract_no (FS-style, e.g. FS20260223060).
--      orders._id (MongoDB hex 699c64...) is NEVER written into
--      finance_payments.contract_no.
--   2. UPDATE block stays commented out — preview-only.
--   3. Rows where orders.contract_no is empty are skipped (not backfilled
--      with _id, not backfilled with anything).
-- ═══════════════════════════════════════════════════════════════════

-- ── 0. Hard guard: confirm no row currently has Mongo-hex contract_no ─
-- (Mongo ObjectIds are 24-char lowercase hex.)
SELECT '── 0. Sanity check: existing contract_no formats ──' AS section;
SELECT
  CASE
    WHEN contract_no ~ '^[a-f0-9]{24}$' THEN 'looks_like_mongo_hex (BAD)'
    WHEN contract_no LIKE 'FS%' OR contract_no LIKE 'BB%'
      OR contract_no LIKE 'AA%' OR contract_no LIKE 'CN-%' THEN 'human_readable'
    WHEN contract_no IS NULL OR contract_no = '' THEN '(null/empty)'
    ELSE 'other'
  END AS contract_no_shape,
  COUNT(*) AS cnt
FROM finance_payments
GROUP BY 1
ORDER BY cnt DESC;

-- ── 1. Preview candidates (would-be linked rows) ────────────────
SELECT '── 1. Candidates for backfill (FS-style only) ──' AS section;
SELECT
  fp.id                              AS payment_id,
  fp.order_no                        AS fp_order_no,
  fp.contract_no                     AS fp_current_contract_no,
  o.contract_no                      AS would_set_to_FS_style,
  o._id                              AS would_NEVER_use_this_mongo_id,
  fp.amount, fp.currency
FROM finance_payments fp
JOIN orders o
  ON o.order_no = fp.order_no
 AND o.contract_no IS NOT NULL AND o.contract_no != ''
WHERE  fp.order_no IS NOT NULL AND fp.order_no != ''
  AND  fp.order_no NOT LIKE '%,%'
  AND  (fp.contract_no IS NULL OR fp.contract_no = '')
ORDER BY fp.id
LIMIT 50;

-- ── 2. Summary buckets ─────────────────────────────────────────
SELECT '── 2. Backfill bucket summary ──' AS section;
SELECT
  CASE
    WHEN fp.order_no IS NULL OR fp.order_no = '' THEN 'no_order_no'
    WHEN fp.order_no LIKE '%,%'                  THEN 'multi_order_skipped'
    WHEN fp.contract_no IS NOT NULL AND fp.contract_no != '' THEN 'already_linked'
    WHEN o.contract_no IS NOT NULL AND o.contract_no != ''   THEN 'will_link_with_FS_style'
    WHEN o.contract_no IS NULL OR o.contract_no = ''         THEN 'orders_has_no_FS_style_skipped'
    ELSE 'orphan_no_match'
  END AS status,
  COUNT(*) AS cnt,
  ROUND(SUM(fp.amount)::numeric, 2) AS total_amount
FROM finance_payments fp
LEFT JOIN orders o ON o.order_no = fp.order_no
GROUP BY 1
ORDER BY cnt DESC;

-- ═══════════════════════════════════════════════════════════════════
-- UPDATE BLOCK · DO NOT EXECUTE WITHOUT HUMAN REVIEW
--
-- This block is intentionally commented out. After Damon reviews the
-- output above and confirms section 1 / section 2 numbers look right,
-- run manually:
--
-- BEGIN;
--
--   -- ⚠️  ONLY uses o.contract_no (FS-style). NEVER o._id.
--   -- Rows where orders.contract_no is empty are NOT backfilled.
--   UPDATE finance_payments fp
--   SET    contract_no = o.contract_no,
--          updated_at  = NOW()
--   FROM   orders o
--   WHERE  fp.order_no = o.order_no
--     AND  fp.order_no IS NOT NULL AND fp.order_no != ''
--     AND  fp.order_no NOT LIKE '%,%'
--     AND  (fp.contract_no IS NULL OR fp.contract_no = '')
--     AND  o.contract_no IS NOT NULL AND o.contract_no != '';
--
--   -- Verify no Mongo-hex slipped in
--   SELECT COUNT(*) AS mongo_hex_rows_should_be_zero
--   FROM   finance_payments
--   WHERE  contract_no ~ '^[a-f0-9]{24}$';
--
--   -- Verify linked count
--   SELECT
--     CASE WHEN contract_no IS NULL OR contract_no = '' THEN 'unlinked' ELSE 'linked' END,
--     COUNT(*)
--   FROM finance_payments
--   GROUP BY 1;
--
-- ROLLBACK;  -- flip to COMMIT only when sanity check returns 0
-- ═══════════════════════════════════════════════════════════════════
