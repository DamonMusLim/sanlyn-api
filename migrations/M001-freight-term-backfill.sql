-- M001: freight_term backfill
-- Idempotent: only updates rows where freight_term is NULL or empty string.
-- Does NOT invent values for rows with no source data — empty stays empty.
-- Run: psql -h 127.0.0.1 -U sanlyn_admin -d sanlyn_db -f M001-freight-term-backfill.sql

BEGIN;

-- Step A: from raw JSON fields (raw->>'tradeTerm' or raw->>'incoterm')
-- Covers ~4 rows confirmed in DB scan
UPDATE shipping_plans
SET freight_term = UPPER(TRIM(
  COALESCE(
    NULLIF(raw->>'tradeTerm', ''),
    NULLIF(raw->>'incoterm', '')
  )
))
WHERE (freight_term IS NULL OR freight_term = '')
  AND (
    (raw->>'tradeTerm' IS NOT NULL AND raw->>'tradeTerm' != '')
    OR (raw->>'incoterm' IS NOT NULL AND raw->>'incoterm' != '')
  );

SELECT 'Step A (raw JSON): ' || COUNT(*) || ' rows updated'
FROM shipping_plans
WHERE freight_term IN ('FOB','EXW','CIF','CNF','CFR','DDP','DAP','FCA','CPT','CIP')
  AND (raw->>'tradeTerm' IS NOT NULL OR raw->>'incoterm' IS NOT NULL);

-- Step B: from orders.trade_terms via order_nos array join
-- order_nos may have company prefix like "38-XM-246"; orders.order_no has "XM-246"
-- We try both exact match and prefix-stripped match
WITH matched AS (
  SELECT DISTINCT
    sp.id AS plan_id,
    o.trade_terms
  FROM shipping_plans sp
  CROSS JOIN LATERAL unnest(sp.order_nos) AS on_raw
  JOIN orders o ON (
    o.order_no = on_raw
    OR o.order_no = regexp_replace(on_raw, '^\d+-', '')
    OR o.contract_no = on_raw
    OR o.contract_no = regexp_replace(on_raw, '^\d+-', '')
  )
  WHERE (sp.freight_term IS NULL OR sp.freight_term = '')
    AND o.trade_terms IS NOT NULL
    AND o.trade_terms != ''
)
UPDATE shipping_plans sp
SET freight_term = UPPER(TRIM(m.trade_terms))
FROM matched m
WHERE sp.id = m.plan_id;

SELECT 'Step B (orders join): ' || COUNT(*) || ' rows now have freight_term'
FROM shipping_plans
WHERE freight_term IS NOT NULL AND freight_term != '';

-- Summary
SELECT
  COUNT(*) AS total,
  COUNT(CASE WHEN freight_term IS NOT NULL AND freight_term != '' THEN 1 END) AS has_term,
  COUNT(CASE WHEN freight_term IS NULL OR freight_term = '' THEN 1 END) AS still_missing
FROM shipping_plans;

COMMIT;
