-- ══════════════════════════════════════════════════════════
-- Migration 001: tenant_id + audit_log + api_keys
-- Run against sanlyn_db (PostgreSQL)
-- Date: 2026-04-12
-- ══════════════════════════════════════════════════════════

-- ╔══════════════════════════════════════════════════════╗
-- ║  PART 1: tenant_id — 数据隔离的地基                    ║
-- ╚══════════════════════════════════════════════════════╝

-- 默认租户（你自己的公司）
-- 所有现有数据都归属这个租户
DO $$
BEGIN
  -- 确保 tenants 表有 id 字段可以引用
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE company_code = 'SANLYN') THEN
    INSERT INTO tenants (company_code, company_name_cn, company_name_en, config)
    VALUES ('SANLYN', '三联国际', 'SANLYN INTERNATIONAL', '{"default": true}'::jsonb);
  END IF;
END $$;

-- 给核心业务表加 tenant_id
-- 默认值 'SANLYN' 确保现有数据自动归属
ALTER TABLE orders            ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(20) DEFAULT 'SANLYN';
ALTER TABLE shipping_plans    ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(20) DEFAULT 'SANLYN';
ALTER TABLE customs_data      ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(20) DEFAULT 'SANLYN';
ALTER TABLE products          ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(20) DEFAULT 'SANLYN';
ALTER TABLE customers         ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(20) DEFAULT 'SANLYN';
ALTER TABLE finance_records   ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(20) DEFAULT 'SANLYN';
ALTER TABLE accounts          ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(20) DEFAULT 'SANLYN';

-- 给现有数据补上 tenant_id（如果还是 NULL）
UPDATE orders          SET tenant_id = 'SANLYN' WHERE tenant_id IS NULL;
UPDATE shipping_plans  SET tenant_id = 'SANLYN' WHERE tenant_id IS NULL;
UPDATE products        SET tenant_id = 'SANLYN' WHERE tenant_id IS NULL;
UPDATE customers       SET tenant_id = 'SANLYN' WHERE tenant_id IS NULL;
UPDATE accounts        SET tenant_id = 'SANLYN' WHERE tenant_id IS NULL;

-- 索引：每张表按 tenant_id 查询会非常频繁
CREATE INDEX IF NOT EXISTS idx_orders_tenant          ON orders(tenant_id);
CREATE INDEX IF NOT EXISTS idx_shipping_plans_tenant   ON shipping_plans(tenant_id);
CREATE INDEX IF NOT EXISTS idx_products_tenant         ON products(tenant_id);
CREATE INDEX IF NOT EXISTS idx_customers_tenant        ON customers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_accounts_tenant         ON accounts(tenant_id);


-- ╔══════════════════════════════════════════════════════╗
-- ║  PART 2: audit_log — 独立审计日志表                    ║
-- ╚══════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     VARCHAR(20) DEFAULT 'SANLYN',

  -- 谁
  user_id       VARCHAR(100),         -- 操作人用户名
  user_name     VARCHAR(200),         -- 操作人显示名
  user_role     VARCHAR(50),          -- admin / customer / staff

  -- 什么时候
  created_at    TIMESTAMPTZ DEFAULT NOW(),

  -- 对什么操作
  table_name    VARCHAR(100) NOT NULL, -- orders / shipping_plans / ...
  record_id     VARCHAR(200),          -- 被操作记录的 ID 或 contract_no
  action        VARCHAR(20) NOT NULL,  -- INSERT / UPDATE / DELETE / LOGIN / EXPORT

  -- 改了什么
  old_values    JSONB,                 -- 修改前的值（UPDATE/DELETE 时记录）
  new_values    JSONB,                 -- 修改后的值（INSERT/UPDATE 时记录）
  changes       JSONB,                 -- 只记录变化的字段 {field: {old, new}}

  -- 从哪来的
  ip_address    VARCHAR(50),
  user_agent    TEXT,

  -- 备注
  note          TEXT
);

-- 查询索引：按时间倒序、按表名、按记录
CREATE INDEX IF NOT EXISTS idx_audit_tenant_time   ON audit_log(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_table_record  ON audit_log(table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_audit_user          ON audit_log(user_id);


-- ╔══════════════════════════════════════════════════════╗
-- ║  PART 3: api_keys — API 鉴权                         ║
-- ╚══════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS api_keys (
  id            SERIAL PRIMARY KEY,
  tenant_id     VARCHAR(20) DEFAULT 'SANLYN',
  key_name      VARCHAR(100) NOT NULL,       -- 用途说明：frontend / n8n / webhook
  api_key       VARCHAR(64) NOT NULL UNIQUE, -- 实际的 key 值
  permissions   JSONB DEFAULT '["read"]',    -- ["read"] / ["read","write"] / ["admin"]
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ                  -- NULL = 永不过期
);

CREATE INDEX IF NOT EXISTS idx_apikeys_key ON api_keys(api_key) WHERE is_active = true;

-- 生成默认 API Key（前端用）
-- 用 PostgreSQL 生成随机 key
INSERT INTO api_keys (tenant_id, key_name, api_key, permissions)
VALUES (
  'SANLYN',
  'frontend-app',
  'sk_' || encode(gen_random_bytes(24), 'hex'),
  '["read","write"]'::jsonb
)
ON CONFLICT DO NOTHING;

-- 生成 webhook/同步用的 key
INSERT INTO api_keys (tenant_id, key_name, api_key, permissions)
VALUES (
  'SANLYN',
  'webhook-sync',
  'sk_' || encode(gen_random_bytes(24), 'hex'),
  '["read","write"]'::jsonb
)
ON CONFLICT DO NOTHING;


-- ╔══════════════════════════════════════════════════════╗
-- ║  查看生成的 API Keys（运行后复制保存）                   ║
-- ╚══════════════════════════════════════════════════════╝
-- SELECT key_name, api_key, permissions FROM api_keys WHERE tenant_id = 'SANLYN';
