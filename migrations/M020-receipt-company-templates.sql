-- 收款证明公司抬头模版（"模版1/模版2..."，Damon 可编辑）
CREATE TABLE IF NOT EXISTS receipt_company_templates (
  id BIGSERIAL PRIMARY KEY,
  template_key TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL,
  company_name TEXT NOT NULL,
  org_code_full TEXT NOT NULL,
  trade_type TEXT NOT NULL DEFAULT 'service' CHECK (trade_type IN ('service','goods')),
  filler_tel TEXT,
  seal_url TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO receipt_company_templates (template_key, label, company_name, org_code_full, trade_type, filler_tel, notes)
VALUES
  ('template1_xiamen_babi', '模版1·厦门巴匕(货物贸易)', 'XIAMEN PET BABY IMPORT AND EXPORT CO., LTD', '91350206MA34RW3852', 'goods', '18609058888', '货物贸易场景;报关经营单位=同收款企业'),
  ('template2_shanghai_oceanbaby', '模版2·上海洋宝宝(海运费/服务贸易)', 'Shanghai Ocean Baby International Logistics Co.,Ltd.', '91310106MAE9L4AQ28', 'service', '18609058888', '出口海运费场景;国际收支编码固定222011')
ON CONFLICT (template_key) DO NOTHING;
