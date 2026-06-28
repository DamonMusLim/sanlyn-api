-- M005 (2026-06-28): 实体治理 + 成本采用 的结构基底。
-- 幂等(IF NOT EXISTS / OR REPLACE)。仅结构,数据修正见 migrations/data/D20260628-*.sql。

-- 1) 公司别名表(实体解析:文本→companies.code)
CREATE TABLE IF NOT EXISTS company_aliases (
  id bigserial PRIMARY KEY,
  company_code text NOT NULL REFERENCES companies(code),
  alias_text text NOT NULL,
  normalized_alias text NOT NULL,
  source text,
  confidence numeric,
  status text DEFAULT 'active',
  created_by text,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT company_aliases_status_check CHECK (status IN ('active','rejected','pending')),
  CONSTRAINT company_aliases_source_check CHECK (source IS NULL OR source IN ('manual','excel','ai','ocr','import')),
  CONSTRAINT company_aliases_confidence_check CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  UNIQUE (normalized_alias)
);
CREATE INDEX IF NOT EXISTS idx_company_aliases_company_code ON company_aliases (company_code);

-- 2) 实体解析日志(AI考试卷 + 别名学习源)
CREATE TABLE IF NOT EXISTS entity_resolution_log (
  id bigserial PRIMARY KEY,
  domain_key text, source_type text, entity_type text, raw_text text, normalized_text text,
  candidates jsonb, suggested_company_code text, confidence numeric, chosen_company_code text,
  outcome text, is_critical boolean DEFAULT false, enforcement text, reviewed_by text,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT entity_resolution_log_source_type_check CHECK (source_type IS NULL OR source_type IN ('manual','excel','ai','ocr','script')),
  CONSTRAINT entity_resolution_log_outcome_check CHECK (outcome IS NULL OR outcome IN ('accepted','corrected','rejected','forced','pending')),
  CONSTRAINT entity_resolution_log_enforcement_check CHECK (enforcement IS NULL OR enforcement IN ('hard','soft')),
  CONSTRAINT entity_resolution_log_confidence_check CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);
CREATE INDEX IF NOT EXISTS idx_entity_resolution_log_domain_created ON entity_resolution_log (domain_key, created_at);

-- 3) 运价采用回链列
ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS freight_rate_id integer;

-- 4) 公司合并重定向列(旧码→canonical)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS merged_into_code text;

-- 5) 排除作废的运费明细视图(成本视图只读它)
CREATE OR REPLACE VIEW active_freight_supplier_bills AS
SELECT * FROM freight_supplier_bills WHERE COALESCE(rebill_status,'') <> 'voided';
