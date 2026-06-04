-- ══════════════════════════════════════════════════════════════════════════════
-- Rollback 027: 撤销字段审计 schema 修正
-- 整体 BEGIN/COMMIT 包裹; 执行带 psql -v ON_ERROR_STOP=1
-- 依赖 _migration_027_*_backup 表恢复被 DROP/转换的数据
-- 回滚完整性说明:
--   - payment_term(varchar) / total_gross_weight_kg(numeric): 原列无 default/约束/索引(已查),
--     重建列 + 备份恢复数据 = 对这两列的完整回滚
--   - freight_rates.valid_from/valid_to: 从 _freight_dates_backup 恢复原始字符串原文,
--     再转回 varchar = 完整回滚 (含原始文本格式)
--   - container_type: 从备份表逐行恢复脏值原文
--   - 新增列(doc_cutoff/hbl_no/mbl_no/pi_no/sc_no/brand_authorization_no/factory_registration_no): 直接 DROP
-- Date: 2026-05-23
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;
SET LOCAL search_path TO public;

-- ─────────────────────────────────────────────────────────────────────────────
-- R-STEP 5: container_type 恢复脏值 (从备份表逐行)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='_migration_027_container_type_backup') THEN
    UPDATE public.orders o
       SET container_type = b.container_type
      FROM public._migration_027_container_type_backup b
     WHERE b.tbl='orders' AND b.row_id=o.id;
    UPDATE public.shipping_plans s
       SET container_type = b.container_type
      FROM public._migration_027_container_type_backup b
     WHERE b.tbl='shipping_plans' AND b.row_id=s.id;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- R-STEP 4: 删除 products 新增列
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.products DROP COLUMN IF EXISTS brand_authorization_no;
ALTER TABLE public.products DROP COLUMN IF EXISTS factory_registration_no;

-- ─────────────────────────────────────────────────────────────────────────────
-- R-STEP 3: orders — 删 pi_no/sc_no; 重建并恢复 payment_term / total_gross_weight_kg
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.orders DROP COLUMN IF EXISTS pi_no;
ALTER TABLE public.orders DROP COLUMN IF EXISTS sc_no;

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_term character varying;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS total_gross_weight_kg numeric;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='_migration_027_payment_term_backup') THEN
    UPDATE public.orders o SET payment_term = b.payment_term
      FROM public._migration_027_payment_term_backup b WHERE b.order_id = o.id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='_migration_027_tgw_backup') THEN
    UPDATE public.orders o SET total_gross_weight_kg = b.total_gross_weight_kg
      FROM public._migration_027_tgw_backup b WHERE b.order_id = o.id;
  END IF;
END $$;
-- 注: payment_terms/gross_weight 的 merge 是仅填空(COALESCE式), 原值未覆盖, 无需回退

-- ─────────────────────────────────────────────────────────────────────────────
-- R-STEP 2: freight_rates valid_from/valid_to date → varchar, 并恢复原始字符串
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name='freight_rates' AND column_name='valid_from') = 'date' THEN
    ALTER TABLE public.freight_rates ALTER COLUMN valid_from TYPE character varying USING valid_from::text;
  END IF;
END $$;
DO $$ BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name='freight_rates' AND column_name='valid_to') = 'date' THEN
    ALTER TABLE public.freight_rates ALTER COLUMN valid_to TYPE character varying USING valid_to::text;
  END IF;
END $$;
-- 恢复原始字符串原文 (覆盖 ::text 规范化结果)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='_migration_027_freight_dates_backup') THEN
    UPDATE public.freight_rates f
       SET valid_from = b.valid_from,
           valid_to   = b.valid_to
      FROM public._migration_027_freight_dates_backup b
     WHERE b.id = f.id;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- R-STEP 1: 删除 shipping_plans 新增列
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.shipping_plans DROP COLUMN IF EXISTS doc_cutoff;
ALTER TABLE public.shipping_plans DROP COLUMN IF EXISTS hbl_no;
ALTER TABLE public.shipping_plans DROP COLUMN IF EXISTS mbl_no;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 备份表清理 (确认回滚成功后手动跑, 默认保留)
-- ─────────────────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS public._migration_027_payment_term_backup;
-- DROP TABLE IF EXISTS public._migration_027_tgw_backup;
-- DROP TABLE IF EXISTS public._migration_027_container_type_backup;
-- DROP TABLE IF EXISTS public._migration_027_freight_dates_backup;
