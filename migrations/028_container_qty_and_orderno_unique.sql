-- ══════════════════════════════════════════════════════════════════════════════
-- Migration 028: D1 shipping_plans.container_qty + 多柜规范化 · D3 orders.order_no UNIQUE
-- 依据: Damon 拍板 5 决策点 (2026-05-23) · 前置: migration 027
-- 配套回滚: 028_..._rollback.sql
--
-- 安全设计 (沿用 027 纪律):
--   - 整体 BEGIN/COMMIT 事务; 执行带 psql -v ON_ERROR_STOP=1
--   - public schema 限定 (SET LOCAL search_path)
--   - 前置存在性 + 约束前阻断式校验 (RAISE EXCEPTION)
--   - 改动前备份 (_migration_028_container_backup); 全幂等
--   - container_type 规范化 UPDATE 限定 4 个已知多柜值, 数量入 container_qty
-- 预检 (2026-05-23 生产): 4 行多柜值 id 122/162/164/240; order_no 96/96 唯一, 0 NULL
-- 注: 无 orders×products JOIN
-- Date: 2026-05-23
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;
SET LOCAL search_path TO public;

-- ═══ 前置存在性 ═══
DO $$ DECLARE miss text := '';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='shipping_plans') THEN miss:=miss||'table:shipping_plans '; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='orders') THEN miss:=miss||'table:orders '; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='shipping_plans' AND column_name='container_type') THEN miss:=miss||'shipping_plans.container_type '; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='order_no') THEN miss:=miss||'orders.order_no '; END IF;
  IF miss <> '' THEN RAISE EXCEPTION 'ABORT: 缺必需表/列 → %', miss; END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- D1: shipping_plans 加 container_qty + 规范化 4 行内嵌数量的多柜值
-- ═══════════════════════════════════════════════════════════════════════════

-- 锁表防并发写入污染预检与规范化窗口 (事务结束自动释放)
LOCK TABLE public.shipping_plans IN SHARE ROW EXCLUSIVE MODE;

-- D1.1 加列 (幂等)
ALTER TABLE public.shipping_plans ADD COLUMN IF NOT EXISTS container_qty integer;
COMMENT ON COLUMN public.shipping_plans.container_qty IS '柜数; 028 从多柜 container_type 内嵌数量抽出; 单柜行暂留 NULL(=1, 数据层 B 类回填)';

-- D1.2 备份将被规范化的行 (幂等: 仅当备份表不存在时建)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='_migration_028_container_backup') THEN
    EXECUTE 'CREATE TABLE public._migration_028_container_backup AS
             SELECT id, container_type, container_qty FROM public.shipping_plans
              WHERE container_type IN (''HC40,HC40,HC40'',''40HQ×2'',''20GP×3'',''2x40HC'')';
  END IF;
END $$;

-- D1.3 预检: 待规范化的多柜值是否都在已知映射内 (出现未知多柜值 → 中止, 防漏映射)
DO $$ DECLARE c int;
BEGIN
  SELECT COUNT(*) INTO c FROM public.shipping_plans
   WHERE container_type ~ '[×x,]'
     AND container_type NOT IN ('HC40,HC40,HC40','40HQ×2','20GP×3','2x40HC');
  IF c > 0 THEN RAISE EXCEPTION 'ABORT: 出现未在映射表内的多柜 container_type % 行, 请先补映射', c; END IF;
END $$;

-- D1.3b 一致性守卫 (Codex #1): 若多柜行 container_qty 已有值且 ≠ 映射数量 → 中止,
--   避免"qty 非空导致 container_type 永远不被规范化"的隐性脏状态. 等于映射值则放行(幂等重跑安全).
DO $$ DECLARE bad int;
BEGIN
  SELECT COUNT(*) INTO bad FROM public.shipping_plans
   WHERE container_type IN ('HC40,HC40,HC40','40HQ×2','20GP×3','2x40HC')
     AND container_qty IS NOT NULL
     AND container_qty <> CASE container_type
           WHEN 'HC40,HC40,HC40' THEN 3 WHEN '40HQ×2' THEN 2
           WHEN '20GP×3' THEN 3 WHEN '2x40HC' THEN 2 END;
  IF bad > 0 THEN RAISE EXCEPTION 'ABORT: % 行多柜值的 container_qty 已存在且与映射数量不符, 人工核对后再跑', bad; END IF;
END $$;

-- D1.4 规范化: container_type → ISO, 数量 → container_qty (仅限 4 个已知值)
-- 幂等且无脏状态: 无论 qty 是否已填(经 D1.3b 守卫确保已填的=正确值), 都把 container_type 规范化为单一 ISO.
-- 执行前后请跑 row count 核对 (见文件末 VERIFICATION)
UPDATE public.shipping_plans
   SET container_qty = COALESCE(container_qty, CASE container_type
         WHEN 'HC40,HC40,HC40' THEN 3
         WHEN '40HQ×2'         THEN 2
         WHEN '20GP×3'         THEN 3
         WHEN '2x40HC'         THEN 2
       END),
       container_type = CASE container_type
         WHEN 'HC40,HC40,HC40' THEN '40HQ'
         WHEN '40HQ×2'         THEN '40HQ'
         WHEN '20GP×3'         THEN '20GP'
         WHEN '2x40HC'         THEN '40HQ'
       END
 WHERE container_type IN ('HC40,HC40,HC40','40HQ×2','20GP×3','2x40HC');

-- ═══════════════════════════════════════════════════════════════════════════
-- D3: orders.order_no 加 UNIQUE + NOT NULL + 非空 CHECK (确保永远可作导入匹配键)
-- ═══════════════════════════════════════════════════════════════════════════

-- 锁表防并发写入在预检与约束生效之间插入 NULL/空串
LOCK TABLE public.orders IN SHARE ROW EXCLUSIVE MODE;

-- D3.1 预检: order_no 不得有重复 / NULL / 空串 (否则加约束会失败, 提前清晰中止)
DO $$ DECLARE dup int; nul int;
BEGIN
  SELECT COUNT(*) INTO nul FROM public.orders WHERE order_no IS NULL OR btrim(order_no) = '';
  IF nul > 0 THEN RAISE EXCEPTION 'ABORT: orders.order_no 有 % 行 NULL/空串, 无法加 UNIQUE', nul; END IF;
  SELECT COUNT(*) INTO dup FROM (SELECT order_no FROM public.orders GROUP BY order_no HAVING COUNT(*)>1) d;
  IF dup > 0 THEN RAISE EXCEPTION 'ABORT: orders.order_no 有 % 个重复值, 无法加 UNIQUE', dup; END IF;
END $$;

-- D3.2 NOT NULL (幂等: 已是 NOT NULL 时为无副作用 no-op)
ALTER TABLE public.orders ALTER COLUMN order_no SET NOT NULL;

-- D3.3 非空 CHECK (幂等)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_orders_order_no_not_blank' AND conrelid='public.orders'::regclass) THEN
    ALTER TABLE public.orders ADD CONSTRAINT ck_orders_order_no_not_blank CHECK (btrim(order_no) <> '');
  END IF;
END $$;

-- D3.4 UNIQUE 约束 (幂等)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='uq_orders_order_no' AND conrelid='public.orders'::regclass) THEN
    ALTER TABLE public.orders ADD CONSTRAINT uq_orders_order_no UNIQUE (order_no);
  END IF;
END $$;

COMMIT;

-- ══════════════════════════════════════════════════════════════════════════════
-- VERIFICATION (COMMIT 后手动核对)
-- ══════════════════════════════════════════════════════════════════════════════
-- D1 残余多柜值 (应 0): SELECT container_type, COUNT(*) FROM shipping_plans WHERE container_type ~ '[×x,]' GROUP BY 1;
-- D1 新值: SELECT id, container_type, container_qty FROM shipping_plans WHERE id IN (122,162,164,240) ORDER BY id;
--          期望 122→40HQ/3, 162→40HQ/2, 164→20GP/3, 240→40HQ/2
-- D3 约束: SELECT conname FROM pg_constraint WHERE conname='uq_orders_order_no';
