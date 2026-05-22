-- ══════════════════════════════════════════════════════════════════════════════
-- Rollback 028: 撤销 D1 (container_qty + 规范化) 与 D3 (order_no UNIQUE)
-- 执行带 psql -v ON_ERROR_STOP=1; 依赖 _migration_028_container_backup 恢复脏值
-- Date: 2026-05-23
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;
SET LOCAL search_path TO public;

-- ── R-D3: 删 order_no UNIQUE + CHECK + NOT NULL ──
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS uq_orders_order_no;
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS ck_orders_order_no_not_blank;
ALTER TABLE public.orders ALTER COLUMN order_no DROP NOT NULL;

-- ── R-D1: 从备份恢复 4 行 container_type + container_qty 原值 ──
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='_migration_028_container_backup') THEN
    UPDATE public.shipping_plans s
       SET container_type = b.container_type,
           container_qty  = b.container_qty
      FROM public._migration_028_container_backup b
     WHERE b.id = s.id;
  END IF;
END $$;

-- ── R-D1: 删 container_qty 列 ──
ALTER TABLE public.shipping_plans DROP COLUMN IF EXISTS container_qty;

COMMIT;

-- 确认回滚成功后手动清理备份 (默认保留 1-2 周):
-- DROP TABLE IF EXISTS public._migration_028_container_backup;
