-- M041 承运人要求规则引擎 + 货品申报字段(海运协同第2件)
-- Damon 07-26 实战:COSCO 订舱强制签货物申报保函+货品信息,每票一签。别写死 if COSCO,做数据驱动规则。
-- 全部 IF NOT EXISTS,幂等安全,纯 additive。

-- 1. 承运人要求规则(后台可配,加船司=插一行,不改代码)
CREATE TABLE IF NOT EXISTS carrier_requirement_rules (
  id            SERIAL PRIMARY KEY,
  carrier_code  VARCHAR(20) NOT NULL,          -- COSU=中远
  carrier_name  VARCHAR(120),
  origin_port   VARCHAR(40),                   -- NULL=任意
  dest_port     VARCHAR(40),
  trade_lane    VARCHAR(60),
  cargo_category VARCHAR(60),
  hs_code_prefixes TEXT[],                      -- NULL=任意
  container_type VARCHAR(20),
  requirements  JSONB NOT NULL DEFAULT '{}'::jsonb,  -- requires_loi/cargo_declaration/dg_declaration/temp_setting/fumigation_cert/msds/animal_feed_statement
  required_of_role VARCHAR(40),                 -- magic_links.recipient_role,谁来做
  is_blocking   BOOLEAN NOT NULL DEFAULT true,  -- 不完成能否放舱
  blocking_stage VARCHAR(30),                   -- booking_release/si_submit/customs/gate_in/bl_release
  due_anchor    VARCHAR(30),                    -- 挂哪个截止:booking/si_cutoff/vgm_cutoff
  per_shipment  BOOLEAN NOT NULL DEFAULT true,  -- true=每票签;false=主协议一次
  effective_from DATE,
  effective_to  DATE,
  priority      INTEGER NOT NULL DEFAULT 100,
  version       INTEGER NOT NULL DEFAULT 1,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  source_note   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crr_carrier_active ON carrier_requirement_rules (carrier_code, is_active);

-- 2. 每票命中规则后物化的任务(带保函签署证据链;单证/保函不是价格改动,走独立状态机)
CREATE TABLE IF NOT EXISTS shipment_requirement_tasks (
  id            SERIAL PRIMARY KEY,
  shipping_plan_id INTEGER NOT NULL,
  carrier_code  VARCHAR(20),
  rule_id       INTEGER REFERENCES carrier_requirement_rules(id),
  task_type     VARCHAR(40) NOT NULL,          -- LOI_BOOKING/CARGO_DECLARATION/TELEX_LOI/DG_DECLARATION/WOOD_PACKAGING_DECL/VGM
  responsible_role VARCHAR(40),
  status        VARCHAR(20) NOT NULL DEFAULT 'requested',  -- requested/submitted/verified/accepted/rejected/waived
  source_snapshot JSONB,                        -- 命中时 HS/品名/起运港/目的港/船司/ETD
  due_at        TIMESTAMPTZ,
  blocking_stage VARCHAR(30),
  evidence_ref  VARCHAR(120),                   -- 上传件引用
  -- 保函签署证据链(免登录点一下法律太薄,必须落这些)
  loi_template_version VARCHAR(30),
  signed_by     VARCHAR(80),
  signed_title  VARCHAR(80),
  signed_at     TIMESTAMPTZ,
  company_chop_present BOOLEAN,
  reject_reason TEXT,
  verified_by   VARCHAR(80),
  verified_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (shipping_plan_id, rule_id, task_type)  -- 防重复物化
);
CREATE INDEX IF NOT EXISTS srt_plan ON shipment_requirement_tasks (shipping_plan_id, status);

-- 3. 货品申报补字段(净重 nw_ctn / CBM cbm_ctn 已有,只补缺的)
ALTER TABLE order_line_items ADD COLUMN IF NOT EXISTS animal_origin BOOLEAN;
ALTER TABLE order_line_items ADD COLUMN IF NOT EXISTS contains_meat BOOLEAN;
ALTER TABLE order_line_items ADD COLUMN IF NOT EXISTS is_dangerous_goods BOOLEAN;
ALTER TABLE order_line_items ADD COLUMN IF NOT EXISTS un_no VARCHAR(16);
ALTER TABLE order_line_items ADD COLUMN IF NOT EXISTS requires_quarantine_cert BOOLEAN;

-- 4. 种子:COSCO 每票要保函+货品申报(数据,可后台改)
INSERT INTO carrier_requirement_rules
  (carrier_code, carrier_name, requirements, required_of_role, is_blocking, blocking_stage, due_anchor, per_shipment, priority, version, is_active, source_note)
SELECT 'COSU', '中远海运 COSCO',
  '{"requires_loi":true,"requires_cargo_declaration":true}'::jsonb,
  'supplier_portal', true, 'booking_release', 'booking', true, 100, 1, true,
  'Damon 07-26 实战:COSCO 订舱强制签货物申报保函+货品信息,每票一签'
WHERE NOT EXISTS (SELECT 1 FROM carrier_requirement_rules WHERE carrier_code='COSU' AND version=1);
