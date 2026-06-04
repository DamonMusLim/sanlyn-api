-- ════════════════════════════════════════════════════════════════════════
-- 020_products_audit_findings.sql
-- PRODUCTS master-table completeness/correctness audit — 2026-05-22
-- READ-ONLY FINDINGS + SUGGESTED non-destructive remediation.
-- ⚠️ DO NOT auto-run. Data backfill is the owner's job. Review each block.
-- ════════════════════════════════════════════════════════════════════════
--
-- SNAPSHOT (active products = 1403 of 1404 total rows):
--   field            missing(active)   % filled
--   hs_code                0           100.0%   ✅
--   declaration_name       0           100.0%   ✅
--   carton_qty            22            98.4%
--   factory_price        135            90.4%
--   cbm                  229            83.7%
--   net_weight           293            79.1%
--   gross_weight         293            79.1%
--   sale_price_cny       485            65.4%
--   bl_description       698            50.2%   🔴 biggest doc-impacting gap
--
-- bl_description placeholder check ('PET FOOD'/'宠物食品'/'PET FOODS'): 0 rows — CLEAN ✅
-- negative prices / weights: 0 — clean.
-- ════════════════════════════════════════════════════════════════════════


-- ── 1. INSPECT (run these to review; non-mutating) ──────────────────────

-- 1a. Active rows missing each doc-critical field (example SKUs):
--   bl_description gaps:  CA-14S, RAC-mix, TN-14, TN-47, CFF-02 ...
--   sale_price_cny gaps:  CA-14S, RAC-mix, TN-14, TN-47, CFF-02 ...
--   net/gross_weight:     CP2088, TT-390, CP2099, CP2101, CP2102 ...
--   cbm gaps:             CA-14S, TN-14, TN-47, TT-390, TT-377 ...
--   factory_price gaps:   CA-14S, TN-14, TN-47, DFM-02, CFF-07 ...
--   carton_qty gaps:      RAC-mix, CD-04H-RJ, CA-04S-1, RA-73, RAC-49 ...
SELECT sku, product_name, brand, factory_price, sale_price_cny,
       net_weight, gross_weight, cbm, carton_qty, bl_description
FROM products
WHERE active = true
  AND ( bl_description IS NULL OR bl_description = ''
        OR sale_price_cny IS NULL OR sale_price_cny = 0
        OR net_weight IS NULL OR net_weight = 0 )
ORDER BY sku;


-- ── 2. net_weight > gross_weight (physically impossible) ────────────────
-- Only 3 rows, all 14G sachet rounding artifacts (NW 0.014 vs GW 0.01 rounded down).
-- Suggested fix: bump gross_weight to >= net_weight for these 3.
-- REVIEW before running.
/*
UPDATE products
SET gross_weight = net_weight, updated_at = NOW()
WHERE active = true
  AND net_weight IS NOT NULL AND gross_weight IS NOT NULL
  AND net_weight > gross_weight
  AND sku IN ('RAC-mix','RAC-MIX-50','RAC-MIX-100');
*/


-- ── 3. Duplicate (sku,size) groups: 31 groups / 34 extra rows ───────────
-- NOTE: products.sku is intentionally NOT unique (size variants).
-- These dups also vary by BRAND + product_name (same physical SKU sold under
-- multiple brand labels) — they appear LEGITIMATE, NOT corruption.
-- DO NOT blind-dedup. Inspect first:
SELECT sku, size, COUNT(*) AS rows,
       array_agg(DISTINCT brand)        AS brands,
       array_agg(DISTINCT factory_code) AS factories,
       array_agg(id ORDER BY id)        AS ids
FROM products
WHERE active = true
GROUP BY sku, size
HAVING COUNT(*) > 1
ORDER BY rows DESC, sku;


-- ── 4. bl_description backfill (NO blind hardcode) ──────────────────────
-- 698 active rows have empty bl_description. Per hard rule, do NOT hardcode
-- 'PET FOOD/宠物食品' (that exact corruption was previously cleaned).
-- bl_description is the EN/CN goods description printed on the BL — it should
-- be derived per-SKU from declaration_name + product category, NOT a constant.
-- Recommended: backfill from declaration_name where it is a per-SKU value, e.g.:
/*
UPDATE products p
SET bl_description = p.declaration_name, updated_at = NOW()
WHERE p.active = true
  AND (p.bl_description IS NULL OR p.bl_description = '')
  AND p.declaration_name IS NOT NULL AND p.declaration_name <> ''
  AND p.declaration_name NOT IN ('PET FOOD','宠物食品','PET FOOD/宠物食品');
*/
-- Then have a human review the remaining empties — do not invent values.
