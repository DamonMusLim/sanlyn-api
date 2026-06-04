-- ══════════════════════════════════════════════════════════════════════════════
-- Migration 027: 字段审计 schema 修正 (A 类 schema 改动)
-- 依据: docs/architecture/FIELD-STANDARD-PROPOSAL-2026-05-23.md · 前置: migration 026
-- 配套回滚: 027_field_audit_schema_fixes_rollback.sql (完整 down migration)
--
-- 安全设计:
--   - 整体 BEGIN/COMMIT 事务 (PG DDL 事务安全); 任意失败 → 全回滚, 无半迁移
--   - 执行带 psql -v ON_ERROR_STOP=1
--   - public schema 限定 (SET LOCAL search_path)
--   - 前置存在性检查 → 缺表/列时给清晰 RAISE 而非 undefined column
--   - DROP 前用 pg_depend 做"列级依赖全检测"(覆盖普通/表达式/partial 索引 + 约束 + 视图 + 规则)
--   - 日期转换: 严格正则 + 真 round-trip (to_char(v::date)=v) + 异常捕获
--   - 类型判断覆盖 character varying 与 text
--   - 每列独立备份; 仅当备份成功才 DROP; 漂移检测(备份在+源列在 → 中止)
--
-- 备份/回滚语义 (明确, 回应审查):
--   - 备份表随本事务一起 COMMIT; 失败时随事务回滚消失(此时主表也未改, 无需恢复)
--   - 备份表用途 = COMMIT 成功之后, 配合 rollback 脚本做事后回滚
--   - 备份是数据快照(非 DDL 快照); 被删两列经查无 default/约束/索引, 故"重建列+回填"=完整回滚
--
-- 预检(2026-05-23 生产): freight 34行全合法日期; payment_term 0填充; tgw 1行同值;
--   多柜数量已在 container_qty; 被删两列无依赖对象
-- 注: 无 orders×products JOIN(无笛卡尔); 无外部输入拼接(无注入面)
-- Date: 2026-05-23
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;
SET LOCAL search_path TO public;

-- ═══════════════════════════════════════════════════════════════════════════
-- P0. 前置存在性检查 — 缺必需表/列则清晰中止 (回应审查 #8)
-- ═══════════════════════════════════════════════════════════════════════════
DO $$ DECLARE miss text := '';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='orders') THEN miss:=miss||'table:orders '; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='shipping_plans') THEN miss:=miss||'table:shipping_plans '; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='freight_rates') THEN miss:=miss||'table:freight_rates '; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='products') THEN miss:=miss||'table:products '; END IF;
  -- canonical 目标列 (UPDATE 依赖)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='payment_terms') THEN miss:=miss||'orders.payment_terms '; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='gross_weight') THEN miss:=miss||'orders.gross_weight '; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='container_qty') THEN miss:=miss||'orders.container_qty '; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='container_type') THEN miss:=miss||'orders.container_type '; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='freight_rates' AND column_name='valid_from') THEN miss:=miss||'freight_rates.valid_from '; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='freight_rates' AND column_name='valid_to') THEN miss:=miss||'freight_rates.valid_to '; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='shipping_plans' AND column_name='container_type') THEN miss:=miss||'shipping_plans.container_type '; END IF;
  IF miss <> '' THEN RAISE EXCEPTION 'ABORT: 缺必需表/列 → %', miss; END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PRE-FLIGHT 阻断式预检
-- ═══════════════════════════════════════════════════════════════════════════

-- P1. payment_term vs payment_terms 冲突
DO $$ DECLARE c int; BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='payment_term') THEN
    SELECT COUNT(*) INTO c FROM public.orders
     WHERE payment_term IS NOT NULL AND payment_term <> '' AND payment_terms IS NOT NULL AND payment_terms <> '' AND payment_term <> payment_terms;
    IF c > 0 THEN RAISE EXCEPTION 'ABORT: payment_term/payment_terms 冲突 % 行', c; END IF;
  END IF;
END $$;

-- P2. total_gross_weight_kg vs gross_weight 冲突
DO $$ DECLARE c int; BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='total_gross_weight_kg') THEN
    SELECT COUNT(*) INTO c FROM public.orders
     WHERE total_gross_weight_kg IS NOT NULL AND gross_weight IS NOT NULL AND total_gross_weight_kg <> gross_weight;
    IF c > 0 THEN RAISE EXCEPTION 'ABORT: gross_weight/total_gross_weight_kg 冲突 % 行', c; END IF;
  END IF;
END $$;

-- P3. orders 多柜 container_type 与 container_qty 一致性
DO $$ DECLARE c int; BEGIN
  SELECT COUNT(*) INTO c FROM public.orders
   WHERE (container_type='40HQ×2' AND COALESCE(container_qty,0) <> 2)
      OR (container_type='20GP×3' AND COALESCE(container_qty,0) <> 3);
  IF c > 0 THEN RAISE EXCEPTION 'ABORT: orders 多柜 container_type 与 container_qty 不符 % 行', c; END IF;
END $$;

-- P4/P5. freight_rates 日期: 严格格式 + 真 round-trip; 覆盖 varchar 与 text; 独立每列
DO $$
DECLARE r record; bad int; dtype text;
BEGIN
  -- valid_from
  SELECT data_type INTO dtype FROM information_schema.columns
   WHERE table_schema='public' AND table_name='freight_rates' AND column_name='valid_from';
  IF dtype IN ('character varying','text') THEN
    SELECT COUNT(*) INTO bad FROM public.freight_rates
     WHERE valid_from IS NOT NULL AND valid_from <> '' AND valid_from !~ '^\d{4}-\d{2}-\d{2}$';
    IF bad > 0 THEN RAISE EXCEPTION 'ABORT: valid_from % 行非严格 YYYY-MM-DD', bad; END IF;
    bad := 0;
    FOR r IN SELECT valid_from AS v FROM public.freight_rates WHERE valid_from ~ '^\d{4}-\d{2}-\d{2}$' LOOP
      BEGIN
        IF to_char(r.v::date,'YYYY-MM-DD') IS DISTINCT FROM r.v THEN bad := bad + 1; END IF;
      EXCEPTION WHEN others THEN bad := bad + 1; END;
    END LOOP;
    IF bad > 0 THEN RAISE EXCEPTION 'ABORT: valid_from % 行 round-trip 失败(非真实日期)', bad; END IF;
  END IF;
  -- valid_to (独立)
  SELECT data_type INTO dtype FROM information_schema.columns
   WHERE table_schema='public' AND table_name='freight_rates' AND column_name='valid_to';
  IF dtype IN ('character varying','text') THEN
    SELECT COUNT(*) INTO bad FROM public.freight_rates
     WHERE valid_to IS NOT NULL AND valid_to <> '' AND valid_to !~ '^\d{4}-\d{2}-\d{2}$';
    IF bad > 0 THEN RAISE EXCEPTION 'ABORT: valid_to % 行非严格 YYYY-MM-DD', bad; END IF;
    bad := 0;
    FOR r IN SELECT valid_to AS v FROM public.freight_rates WHERE valid_to ~ '^\d{4}-\d{2}-\d{2}$' LOOP
      BEGIN
        IF to_char(r.v::date,'YYYY-MM-DD') IS DISTINCT FROM r.v THEN bad := bad + 1; END IF;
      EXCEPTION WHEN others THEN bad := bad + 1; END;
    END LOOP;
    IF bad > 0 THEN RAISE EXCEPTION 'ABORT: valid_to % 行 round-trip 失败', bad; END IF;
  END IF;
END $$;

-- P6. DROP 前列级依赖全检测 (pg_depend: 覆盖索引/约束/视图/规则; 含表达式/partial 索引)
-- 排除 pg_attrdef (列自身 DEFAULT 定义): 随列自动删除, 无数据风险, 非外部依赖
DO $$ DECLARE dep int; col_num smallint;
BEGIN
  -- payment_term
  SELECT attnum INTO col_num FROM pg_attribute
   WHERE attrelid='public.orders'::regclass AND attname='payment_term' AND NOT attisdropped;
  IF col_num IS NOT NULL THEN
    SELECT COUNT(*) INTO dep FROM pg_depend d
     WHERE d.refobjid='public.orders'::regclass AND d.refobjsubid=col_num
       AND d.classid <> 'pg_attrdef'::regclass;
    IF dep > 0 THEN RAISE EXCEPTION 'ABORT: payment_term 有 % 个列级依赖对象(索引/约束/视图), 不可静默 DROP', dep; END IF;
  END IF;
  -- total_gross_weight_kg
  SELECT attnum INTO col_num FROM pg_attribute
   WHERE attrelid='public.orders'::regclass AND attname='total_gross_weight_kg' AND NOT attisdropped;
  IF col_num IS NOT NULL THEN
    SELECT COUNT(*) INTO dep FROM pg_depend d
     WHERE d.refobjid='public.orders'::regclass AND d.refobjsubid=col_num
       AND d.classid <> 'pg_attrdef'::regclass;
    IF dep > 0 THEN RAISE EXCEPTION 'ABORT: total_gross_weight_kg 有 % 个列级依赖对象, 不可静默 DROP', dep; END IF;
  END IF;
END $$;

-- P7. 漂移检测: 备份表存在但源列仍在 → 前次未完成/手工改动, 中止防陈旧快照
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='_migration_027_payment_term_backup')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='payment_term') THEN
    RAISE EXCEPTION 'ABORT: payment_term 备份表已存在但源列仍在, 疑似漂移, 需人工核对';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='_migration_027_tgw_backup')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='total_gross_weight_kg') THEN
    RAISE EXCEPTION 'ABORT: total_gross_weight_kg 备份表已存在但源列仍在, 疑似漂移';
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 1: shipping_plans 新增列
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE public.shipping_plans ADD COLUMN IF NOT EXISTS doc_cutoff date;
ALTER TABLE public.shipping_plans ADD COLUMN IF NOT EXISTS hbl_no text;
ALTER TABLE public.shipping_plans ADD COLUMN IF NOT EXISTS mbl_no text;
COMMENT ON COLUMN public.shipping_plans.doc_cutoff IS '文件截止日(SI cutoff); 与 cutoff_date 并存; 来源:船司订舱确认书';
COMMENT ON COLUMN public.shipping_plans.hbl_no IS 'House B/L 号(货代出); bl_no 暂留, 迁移见 B 类';
COMMENT ON COLUMN public.shipping_plans.mbl_no IS 'Master B/L 号(船司出); 拼箱必填';

-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 2: freight_rates valid_from/valid_to → date (覆盖 varchar/text; 独立每列)
-- ═══════════════════════════════════════════════════════════════════════════
-- 备份当前两列文本 (独立于各列类型)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='_migration_027_freight_dates_backup') THEN
    EXECUTE 'CREATE TABLE public._migration_027_freight_dates_backup AS
             SELECT id, valid_from::text AS valid_from, valid_to::text AS valid_to FROM public.freight_rates';
  END IF;
END $$;
DO $$ BEGIN
  IF (SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='freight_rates' AND column_name='valid_from') IN ('character varying','text') THEN
    ALTER TABLE public.freight_rates ALTER COLUMN valid_from TYPE date USING NULLIF(valid_from,'')::date;
  END IF;
END $$;
DO $$ BEGIN
  IF (SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='freight_rates' AND column_name='valid_to') IN ('character varying','text') THEN
    ALTER TABLE public.freight_rates ALTER COLUMN valid_to TYPE date USING NULLIF(valid_to,'')::date;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 3: orders 重复列消歧 (每列: 备份 → merge → 仅当备份在才 DROP) + pi_no/sc_no
-- ═══════════════════════════════════════════════════════════════════════════

-- 3a. payment_term
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='payment_term') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='_migration_027_payment_term_backup') THEN
      EXECUTE 'CREATE TABLE public._migration_027_payment_term_backup AS SELECT id AS order_id, payment_term FROM public.orders';
    END IF;
    UPDATE public.orders SET payment_terms = payment_term
     WHERE (payment_terms IS NULL OR payment_terms = '') AND payment_term IS NOT NULL AND payment_term <> '';
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='_migration_027_payment_term_backup') THEN
    ALTER TABLE public.orders DROP COLUMN IF EXISTS payment_term;
  END IF;
END $$;

-- 3b. total_gross_weight_kg
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='total_gross_weight_kg') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='_migration_027_tgw_backup') THEN
      EXECUTE 'CREATE TABLE public._migration_027_tgw_backup AS SELECT id AS order_id, total_gross_weight_kg FROM public.orders';
    END IF;
    UPDATE public.orders SET gross_weight = total_gross_weight_kg
     WHERE gross_weight IS NULL AND total_gross_weight_kg IS NOT NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='_migration_027_tgw_backup') THEN
    ALTER TABLE public.orders DROP COLUMN IF EXISTS total_gross_weight_kg;
  END IF;
END $$;

-- 3c. 新增 pi_no / sc_no
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS pi_no text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS sc_no text;
COMMENT ON COLUMN public.orders.pi_no IS 'PI 编号; 与 contract_no(正式合同号FS)分离; 迁移见 B 类';
COMMENT ON COLUMN public.orders.sc_no IS 'SC 编号; 与 contract_no 分离; 迁移见 B 类';

-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 4: products 新增列
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS brand_authorization_no text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS factory_registration_no text;
COMMENT ON COLUMN public.products.brand_authorization_no IS '品牌授权编号; 报关行查验必查';
COMMENT ON COLUMN public.products.factory_registration_no IS '工厂出口备案号; 宠物食品出口监管合规必填';

-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 5: container_type 值域统一 (P0). 预检 P3 已保证 orders 数量一致
-- ═══════════════════════════════════════════════════════════════════════════
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='_migration_027_container_type_backup') THEN
    EXECUTE $sql$
      CREATE TABLE public._migration_027_container_type_backup AS
        SELECT 'orders'::text AS tbl, id AS row_id, container_type FROM public.orders WHERE container_type IS NOT NULL
        UNION ALL
        SELECT 'shipping_plans'::text, id, container_type FROM public.shipping_plans WHERE container_type IS NOT NULL
    $sql$;
  END IF;
END $$;

UPDATE public.orders
   SET container_type = CASE container_type
       WHEN '40hq' THEN '40HQ' WHEN '40HQ×2' THEN '40HQ'
       WHEN '20gp' THEN '20GP' WHEN '20GP×3' THEN '20GP' ELSE container_type END
 WHERE container_type IN ('40hq','40HQ×2','20gp','20GP×3');

UPDATE public.shipping_plans
   SET container_type = CASE container_type
       WHEN '40hq' THEN '40HQ' WHEN '40HC' THEN '40HQ' WHEN 'HC40' THEN '40HQ'
       WHEN '1x40HQ' THEN '40HQ' WHEN '1x40HC' THEN '40HQ' WHEN '20gp' THEN '20GP' ELSE container_type END
 WHERE container_type IN ('40hq','40HC','HC40','1x40HQ','1x40HC','20gp');

COMMIT;

-- ══════════════════════════════════════════════════════════════════════════════
-- VERIFICATION (COMMIT 后手动核对) — 见 PROPOSAL 文档对应查询
-- ══════════════════════════════════════════════════════════════════════════════
