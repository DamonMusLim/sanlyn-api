-- 2026-05-11 · 48-5 / 48-4 / 40-LL-2 订单快照精确回填
-- 仅这 3 单，不扫全表。配套 Sanlyn-OS PR #144。
--
-- 范围（line 数）：
--   48-5     · 1 行 (CP0902)             — products 主表完整 ✅
--   48-4     · 2 行 (CP1578 / CP1580)    — CP1580 NW/GW/CBM 主表也空 ⚠️
--   40-LL-2  · 7 行 (无 sku, 仅名字匹配) — 单独段落，按名字 hard-map ⚠️
--
-- 用 BEGIN/ROLLBACK 包裹。看完结果，把最后一行 ROLLBACK 改 COMMIT 才真写。

BEGIN;

-- ── 48-5 · CP0902 ────────────────────────────────────────────────
UPDATE orders SET raw = jsonb_set(
  raw,
  '{products}',
  (
    SELECT jsonb_agg(
      CASE WHEN it->>'sku' = 'CP0902'
        THEN it
          || jsonb_build_object(
            'factoryPrice', 5.28,
            'netWeight',    18,
            'grossWeight',  18.5,
            'cbm',          0.021,
            'size',         '6KG/BAG'
          )
        ELSE it
      END
    )
    FROM jsonb_array_elements(raw->'products') AS it
  )
)
WHERE order_no = '48-5'
  AND raw ? 'products';

-- ── 48-4 · CP1578（完整）+ CP1580（仅价 + size）──────────────────
UPDATE orders SET raw = jsonb_set(
  raw,
  '{products}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN it->>'sku' = 'CP1578' THEN it
          || jsonb_build_object(
            'factoryPrice', 1.44,
            'netWeight',    4.65,
            'grossWeight',  5.25,
            'cbm',          0.0313281,
            'size',         '270mm×270mm 1ply 16gsm 110 sheets'
          )
        WHEN it->>'sku' = 'CP1580' THEN it
          || jsonb_build_object(
            'factoryPrice', 1.44,
            'size',         'Kitchen Roll Towel 225mm×225mm 2ply 21gsm 60 sheets 24rolls/CTN'
          )
          -- ⚠️ NW/GW/CBM 主表也空，留给后续 (上游补 products.CP1580 重量后再跑)
        ELSE it
      END
    )
    FROM jsonb_array_elements(raw->'products') AS it
  )
)
WHERE order_no = '48-4'
  AND raw ? 'products';

-- ── 40-LL-2 · 行项无 sku, 按 product_name 1:1 映射 ────────────────
-- 先在事务里用 LATERAL 拿到候选映射, 然后逐行 patch
UPDATE orders o SET raw = jsonb_set(
  o.raw,
  '{products}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN COALESCE(it->>'sku','') = ''
         AND p.sku IS NOT NULL
        THEN it
          || jsonb_build_object('sku', p.sku)
          || CASE WHEN p.factory_price IS NOT NULL THEN jsonb_build_object('factoryPrice', p.factory_price) ELSE '{}'::jsonb END
          || CASE WHEN p.net_weight    IS NOT NULL THEN jsonb_build_object('netWeight',    p.net_weight)    ELSE '{}'::jsonb END
          || CASE WHEN p.gross_weight  IS NOT NULL THEN jsonb_build_object('grossWeight',  p.gross_weight)  ELSE '{}'::jsonb END
          || CASE WHEN p.cbm           IS NOT NULL THEN jsonb_build_object('cbm',          p.cbm)           ELSE '{}'::jsonb END
          || CASE WHEN p.size          IS NOT NULL THEN jsonb_build_object('size',         p.size)          ELSE '{}'::jsonb END
        ELSE it
      END
    )
    FROM jsonb_array_elements(o.raw->'products') AS it
    LEFT JOIN LATERAL (
      SELECT sku, factory_price, net_weight, gross_weight, cbm, size
      FROM products
      WHERE product_name = it->>'name'
         OR product_name = it->>'product_name'
      LIMIT 1
    ) p ON TRUE
  )
)
WHERE o.order_no = '40-LL-2'
  AND o.raw ? 'products';

-- ── 验证 ─────────────────────────────────────────────────────────
SELECT
  order_no,
  jsonb_array_length(raw->'products') AS line_count,
  jsonb_path_query_array(raw, '$.products[*].factoryPrice') AS factory_prices,
  jsonb_path_query_array(raw, '$.products[*].grossWeight') AS gross_weights
FROM orders
WHERE order_no IN ('48-5','48-4','40-LL-2')
ORDER BY order_no;

-- 看完上面 SELECT 结果, 确认每行 factoryPrice 都有数字 (除了 48-4 的 CP1580 是 1.44 但 GW 仍 null)
-- 然后改下面这行 ROLLBACK → COMMIT, 重跑整个文件
ROLLBACK;
-- COMMIT;
