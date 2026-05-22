-- ══════════════════════════════════════════════════════════════════════════════
-- Migration 026: shipping schema 约束补全
-- 前置条件: migration 025 已跑（order_events/order_tasks 已建，8 项 ALTER 已做）
--   验证: SELECT column_name FROM information_schema.columns
--         WHERE table_name='shipping_plans' AND column_name='local_charges_code';
--   必须返回 1 行，否则先跑 025 再跑本脚本。
-- 安全: 全部幂等 (DO $$ + IF NOT EXISTS / IF EXISTS)，无 DROP
-- Codex review: PASS 2026-05-23 (agent a79aceabcc37ea0a1)
-- Date: 2026-05-23
-- ══════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- COLUMN NAME DISAMBIGUATION (Codex MEDIUM #1 response):
--   freight_rates.local_charge_code   (无 s) — 预存列，FK → local_charges，一条运价绑一条港杂费
--   shipping_plans.local_charges_code (有 s) — 025 新增列，FK → local_charges，一条计划绑一条港杂费
--   两者是不同表上功能类似的不同列，命名差异属历史遗留，非 bug。
--   本脚本 STEP 3 处理的是 shipping_plans 端的 FK。
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 0: 补 PRIMARY KEY（freight_rates 当前无 PK 声明；shipping_plans 已有 pkey）
-- 这是 FK 的前提。用 DO 块做幂等保护。
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'freight_rates' AND constraint_type = 'PRIMARY KEY'
  ) THEN
    ALTER TABLE freight_rates ADD PRIMARY KEY (id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'shipping_plans' AND constraint_type = 'PRIMARY KEY'
  ) THEN
    ALTER TABLE shipping_plans ADD PRIMARY KEY (id);
  END IF;
END $$;

-- local_charges.charge_code 唯一约束 (FK 前置)
-- 检查: 按列名查现有 UNIQUE 约束（兼容已存在 local_charges_charge_code_unique 的情况）
-- 预检: 生产已确认 0 条 NULL charge_code（2026-05-23 MCP 验证）
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
    WHERE tc.table_name = 'local_charges'
      AND tc.constraint_type = 'UNIQUE'
      AND ccu.column_name = 'charge_code'
  ) THEN
    ALTER TABLE local_charges ADD CONSTRAINT uq_local_charges_code UNIQUE (charge_code);
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1: FK — orders.shipping_plan_id → shipping_plans(id)
-- ON DELETE SET NULL: 删海运计划不级联删订单
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_orders_shipping_plan'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT fk_orders_shipping_plan
      FOREIGN KEY (shipping_plan_id) REFERENCES shipping_plans(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_orders_shipping_plan_id
  ON orders (shipping_plan_id)
  WHERE shipping_plan_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2: FK — orders.freight_rate_id → freight_rates(id)
-- ON DELETE SET NULL: 删运价不影响已下单
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_orders_freight_rate'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT fk_orders_freight_rate
      FOREIGN KEY (freight_rate_id) REFERENCES freight_rates(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_orders_freight_rate_id
  ON orders (freight_rate_id)
  WHERE freight_rate_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 3: FK — shipping_plans.local_charges_code → local_charges(charge_code)
-- ON DELETE SET NULL: 删港杂费记录不影响现有海运计划
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_shipping_plans_local_charges'
  ) THEN
    ALTER TABLE shipping_plans
      ADD CONSTRAINT fk_shipping_plans_local_charges
      FOREIGN KEY (local_charges_code) REFERENCES local_charges(charge_code) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_shipping_plans_local_charges_code
  ON shipping_plans (local_charges_code)
  WHERE local_charges_code IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 4: freight_rates 日期完整性约束
-- doc_cutoff ≤ sail_date；cargo_cutoff ≤ sail_date
-- NULL-safe: 任一为 NULL 则约束不触发（避免对历史空数据报错）
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'chk_freight_doc_cutoff'
  ) THEN
    ALTER TABLE freight_rates
      ADD CONSTRAINT chk_freight_doc_cutoff
      CHECK (doc_cutoff IS NULL OR sail_date IS NULL OR doc_cutoff <= sail_date);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'chk_freight_cargo_cutoff'
  ) THEN
    ALTER TABLE freight_rates
      ADD CONSTRAINT chk_freight_cargo_cutoff
      CHECK (cargo_cutoff IS NULL OR sail_date IS NULL OR cargo_cutoff <= sail_date);
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 5: freight_rates.currency 枚举约束
-- 历史数据审计结果: 全部 34 行均为 'USD'（2026-05-23 MCP 验证）
-- 若录入其他币种，需先扩展此列表
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'chk_freight_currency'
  ) THEN
    ALTER TABLE freight_rates
      ADD CONSTRAINT chk_freight_currency
      CHECK (currency IN ('USD','CNY','EUR','GBP','MYR','SGD','THB'));
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 6: shipping_plans.ocean_freight_profit_usd — 派生字段说明
--
-- 公式 (应用层写入，非 DB 触发器):
--   ocean_freight_profit_usd =
--     COALESCE(fr.customer_hq40 - fr.hq40, 0) * qty_40hq +
--     COALESCE(fr.customer_gp20 - fr.gp20, 0) * qty_20gp
--
-- 更新时机: 订单绑定 freight_rate_id 时，由 /api/db/orders (PATCH action=bind_rate) 写入
-- 币种: 与 freight_rates.currency 一致（默认 USD）
-- 换算: 若 freight_rates.currency ≠ USD，应用层须先换算再写入
--
-- 约束: 允许负值（亏本单），允许 NULL（未绑定运价时）
-- ─────────────────────────────────────────────────────────────────────────────

-- (无 DDL 变更，仅文档注释)

-- ─────────────────────────────────────────────────────────────────────────────
-- 验证查询 (跑完后手动核对)
-- ─────────────────────────────────────────────────────────────────────────────

-- SELECT constraint_name, constraint_type, table_name
-- FROM information_schema.table_constraints
-- WHERE table_name IN ('orders','freight_rates','shipping_plans','local_charges')
--   AND constraint_type IN ('PRIMARY KEY','FOREIGN KEY','UNIQUE','CHECK')
-- ORDER BY table_name, constraint_type;

-- SELECT indexname, indexdef FROM pg_indexes
-- WHERE tablename IN ('orders','freight_rates','shipping_plans')
--   AND indexname LIKE 'idx_%'
-- ORDER BY tablename;
