-- ✅ 已于 2026-08-27 修正并执行成功（INSERT 0 19 + layout 1 条）。修正记录见文件末尾。
-- Quick Entry missing field_definitions handoff.
-- Human review required before running. No COMMIT in this file.
-- Field id is canonical_key.

-- 1) service_rates truck/customs quick entry fields.
-- Confirm labels, roles, source_column names, required_for_completeness, and layouts before insert.
-- If service_rates already has active field_definitions in production, do not run this block as-is.

INSERT INTO field_definitions (
  canonical_key, module_key, field_key, label, label_cn, type, unit, format, grain,
  input_kind, options_json, validation_json, relationship_json,
  tab, section_key, section_label, section_label_cn, section_order, sort_order,
  editable, visible_roles, editable_roles, col_span,
  source_kind, source_table, source_column, is_system_derived, is_curated, is_legal,
  customs_relevant, stale_risk, show_in_business, show_in_edit, required_for_completeness, status
)
VALUES
  ('service_rates.tier', 'service_rates', 'tier', 'Tier', '轻重档', 'string', NULL, '{}'::jsonb, 'service_rate',
   'select', '["light","heavy","xheavy"]'::jsonb, '{}'::jsonb, '{}'::jsonb,
   'quick_entry', 'price', 'Price', '价格', 40, 45,
   true, '["admin","logistics"]'::jsonb, '["admin","logistics"]'::jsonb, 1,
   'raw_column', 'service_rates', 'tier', false, true, false,
   false, 'medium', true, true, false, 'active'),
  ('service_rates.vehicle_type', 'service_rates', 'vehicle_type', 'Vehicle type', '车型', 'string', NULL, '{}'::jsonb, 'service_rate',
   'text', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
   'quick_entry', 'route', 'Route', '路线', 30, 45,
   true, '["admin","logistics"]'::jsonb, '["admin","logistics"]'::jsonb, 1,
   'raw_column', 'service_rates', 'vehicle_type', false, true, false,
   false, 'medium', true, true, false, 'active'),
  ('service_rates.customs_type', 'service_rates', 'customs_type', 'Customs type', '报关类型', 'string', NULL, '{}'::jsonb, 'service_rate',
   'text', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
   'quick_entry', 'route', 'Route', '路线', 30, 46,
   true, '["admin","logistics"]'::jsonb, '["admin","logistics"]'::jsonb, 1,
   'raw_column', 'service_rates', 'customs_type', false, true, false,
   true, 'medium', true, true, false, 'active'),
  ('service_rates.pod', 'service_rates', 'pod', 'POD', '卸货港', 'string', NULL, '{}'::jsonb, 'service_rate',
   'text', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
   'quick_entry', 'route', 'Route', '路线', 30, 35,
   true, '["admin","logistics"]'::jsonb, '["admin","logistics"]'::jsonb, 1,
   'raw_column', 'service_rates', 'pod', false, true, false,
   false, 'medium', true, true, false, 'active'),
  ('service_rates.service', 'service_rates', 'service', 'Service', '服务类型', 'string', NULL, '{}'::jsonb, 'service_rate',
   'select', '["truck","customs"]'::jsonb, '{}'::jsonb, '{}'::jsonb,
   'quick_entry', 'base', 'Base', '基础', 10, 10,
   true, '["admin","logistics"]'::jsonb, '["admin","logistics"]'::jsonb, 1,
   'raw_column', 'service_rates', 'service', false, true, false,
   false, 'medium', true, true, true, 'active'),
  ('service_rates.price_side', 'service_rates', 'price_side', 'Price side', '成本/销售', 'string', NULL, '{}'::jsonb, 'service_rate',
   'select', '["cost","sell"]'::jsonb, '{}'::jsonb, '{}'::jsonb,
   'quick_entry', 'base', 'Base', '基础', 10, 20,
   true, '["admin","logistics"]'::jsonb, '["admin","logistics"]'::jsonb, 1,
   'raw_column', 'service_rates', 'price_side', false, true, false,
   false, 'medium', true, true, false, 'active'),
  ('service_rates.executor_company_id', 'service_rates', 'executor_company_id', 'Executor company', '执行公司', 'number', NULL, '{}'::jsonb, 'service_rate',
   'text', NULL, '{}'::jsonb, '{"reference":{"target_table":"companies","target_key_field":"id","target_display_field":"name_cn"}}'::jsonb,
   'quick_entry', 'party', 'Party', '公司归属', 20, 10,
   true, '["admin","logistics"]'::jsonb, '["admin","logistics"]'::jsonb, 2,
   'lookup', 'service_rates', 'executor_company_id', false, true, false,
   false, 'medium', true, true, true, 'active'),
  ('service_rates.payable_company_id', 'service_rates', 'payable_company_id', 'Payable company', '付款对象', 'number', NULL, '{}'::jsonb, 'service_rate',
   'text', NULL, '{}'::jsonb, '{"reference":{"target_table":"companies","target_key_field":"id","target_display_field":"name_cn"}}'::jsonb,
   'quick_entry', 'party', 'Party', '公司归属', 20, 20,
   true, '["admin","logistics"]'::jsonb, '["admin","logistics"]'::jsonb, 2,
   'lookup', 'service_rates', 'payable_company_id', false, true, false,
   false, 'medium', true, true, false, 'active'),
  ('service_rates.factory_company_id', 'service_rates', 'factory_company_id', 'Factory company', '工厂公司', 'number', NULL, '{}'::jsonb, 'service_rate',
   'text', NULL, '{}'::jsonb, '{"reference":{"target_table":"companies","target_key_field":"id","target_display_field":"name_cn"}}'::jsonb,
   'quick_entry', 'route', 'Route', '路线', 30, 10,
   true, '["admin","logistics"]'::jsonb, '["admin","logistics"]'::jsonb, 2,
   'lookup', 'service_rates', 'factory_company_id', false, true, false,
   false, 'medium', true, true, false, 'active'),
  ('service_rates.pol', 'service_rates', 'pol', 'POL', '起运港', 'string', NULL, '{}'::jsonb, 'service_rate',
   'text', NULL, '{}'::jsonb, '{"reference":{"target_table":"ports","target_key_field":"code","target_display_field":"name_cn"}}'::jsonb,
   'quick_entry', 'route', 'Route', '路线', 30, 20,
   true, '["admin","logistics"]'::jsonb, '["admin","logistics"]'::jsonb, 1,
   'lookup', 'service_rates', 'pol', false, true, false,
   false, 'medium', true, true, false, 'active'),
  ('service_rates.pickup_place', 'service_rates', 'pickup_place', 'Pickup place', '提货地', 'string', NULL, '{}'::jsonb, 'service_rate',
   'text', NULL, '{}'::jsonb, '{}'::jsonb,
   'quick_entry', 'route', 'Route', '路线', 30, 30,
   true, '["admin","logistics"]'::jsonb, '["admin","logistics"]'::jsonb, 1,
   'raw_column', 'service_rates', 'pickup_place', false, true, false,
   false, 'medium', true, true, false, 'active'),
  ('service_rates.customs_port', 'service_rates', 'customs_port', 'Customs port', '报关口岸', 'string', NULL, '{}'::jsonb, 'service_rate',
   'text', NULL, '{}'::jsonb, '{"reference":{"target_table":"ports","target_key_field":"code","target_display_field":"name_cn"}}'::jsonb,
   'quick_entry', 'route', 'Route', '路线', 30, 40,
   true, '["admin","logistics"]'::jsonb, '["admin","logistics"]'::jsonb, 1,
   'lookup', 'service_rates', 'customs_port', false, true, false,
   true, 'medium', true, true, false, 'active'),
  ('service_rates.container_type', 'service_rates', 'container_type', 'Container type', '箱型', 'string', NULL, '{}'::jsonb, 'service_rate',
   'select', '["20GP","40GP","40HQ","45HQ"]'::jsonb, '{}'::jsonb, '{}'::jsonb,
   'quick_entry', 'price', 'Price', '价格', 40, 10,
   true, '["admin","logistics"]'::jsonb, '["admin","logistics"]'::jsonb, 1,
   'raw_column', 'service_rates', 'container_type', false, true, false,
   false, 'medium', true, true, false, 'active'),
  ('service_rates.rate', 'service_rates', 'rate', 'Rate', '价格', 'number', NULL, '{"precision": 2}'::jsonb, 'service_rate',
   'number', NULL, '{"min":0}'::jsonb, '{}'::jsonb,
   'quick_entry', 'price', 'Price', '价格', 40, 20,
   true, '["admin","logistics"]'::jsonb, '["admin","logistics"]'::jsonb, 1,
   'raw_column', 'service_rates', 'rate', false, true, false,
   false, 'medium', true, true, true, 'active'),
  ('service_rates.currency', 'service_rates', 'currency', 'Currency', '币种', 'string', NULL, '{}'::jsonb, 'service_rate',
   'select', '["CNY","USD"]'::jsonb, '{}'::jsonb, '{}'::jsonb,
   'quick_entry', 'price', 'Price', '价格', 40, 30,
   true, '["admin","logistics"]'::jsonb, '["admin","logistics"]'::jsonb, 1,
   'raw_column', 'service_rates', 'currency', false, true, false,
   false, 'medium', true, true, false, 'active'),
  ('service_rates.unit', 'service_rates', 'unit', 'Unit', '单位', 'string', NULL, '{}'::jsonb, 'service_rate',
   'text', NULL, '{}'::jsonb, '{}'::jsonb,
   'quick_entry', 'price', 'Price', '价格', 40, 40,
   true, '["admin","logistics"]'::jsonb, '["admin","logistics"]'::jsonb, 1,
   'raw_column', 'service_rates', 'unit', false, true, false,
   false, 'medium', true, true, false, 'active'),
  ('service_rates.valid_from', 'service_rates', 'valid_from', 'Valid from', '有效期起', 'date', NULL, '{"kind": "date"}'::jsonb, 'service_rate',
   'date', NULL, '{}'::jsonb, '{}'::jsonb,
   'quick_entry', 'price', 'Price', '价格', 40, 50,
   true, '["admin","logistics"]'::jsonb, '["admin","logistics"]'::jsonb, 1,
   'raw_column', 'service_rates', 'valid_from', false, true, false,
   false, 'medium', true, true, false, 'active'),
  ('service_rates.valid_to', 'service_rates', 'valid_to', 'Valid to', '有效期止', 'date', NULL, '{"kind": "date"}'::jsonb, 'service_rate',
   'date', NULL, '{}'::jsonb, '{}'::jsonb,
   'quick_entry', 'price', 'Price', '价格', 40, 60,
   true, '["admin","logistics"]'::jsonb, '["admin","logistics"]'::jsonb, 1,
   'raw_column', 'service_rates', 'valid_to', false, true, false,
   false, 'medium', true, true, false, 'active'),
  ('service_rates.notes', 'service_rates', 'notes', 'Notes', '备注', 'string', NULL, '{}'::jsonb, 'service_rate',
   'textarea', NULL, '{}'::jsonb, '{}'::jsonb,
   'quick_entry', 'notes', 'Notes', '备注', 50, 10,
   true, '["admin","logistics"]'::jsonb, '["admin","logistics"]'::jsonb, 4,
   'raw_column', 'service_rates', 'notes', false, true, false,
   false, 'medium', true, true, false, 'active');

-- 2) Optional layout after field_definitions are confirmed.
INSERT INTO field_layouts (module_key, version, layout_json, status, updated_by)
VALUES (
  'service_rates',
  1,
  '{"sections":[{"key":"base","label":"基础","fields":["service","price_side"]},{"key":"party","label":"公司归属","fields":["executor_company_id","payable_company_id"]},{"key":"route","label":"路线","fields":["factory_company_id","pol","pod","pickup_place","customs_port","customs_type","vehicle_type"]},{"key":"price","label":"价格","fields":["container_type","tier","rate","currency","unit","valid_from","valid_to"]},{"key":"notes","label":"备注","fields":["notes"]}]}'::jsonb,
  'active',
  'handoff'
)
ON CONFLICT DO NOTHING;

-- ══ 2026-08-27 桌面审核修正记录（原版有 6 层问题，直接跑会写一半就炸）══
-- 1) 漏配 tier / vehicle_type / customs_type / pod —— 前三个正是 M105 刚加的列，不配等于加了用不上
-- 2) format 列是 jsonb，原版写了裸串 'decimal' / 'date'
-- 3) format 是 NOT NULL，原版 16 处传 NULL
-- 4) module_key CHECK 不允许 service_rates（已另行放宽，见 relax-field-definitions-module-key-20260827.sql）
-- 5) source_kind CHECK 只认 raw_column/computed/lookup/constant，原版 14 处写了 'manual'
-- 6) type CHECK 只认 string 不认 text，原版 13 处写了 'text'
-- 教训：写 field_definitions 前先 SELECT pg_get_constraintdef 把 6 条 CHECK 一次查全，别一层层撞。
