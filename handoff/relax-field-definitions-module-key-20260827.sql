-- 已于 2026-08-27 经 Damon 批准执行。留档备查。
-- 原约束只允许 8 个模块，service_rates 不在其中，导致拖车/报关报价无法接入字段引擎。
ALTER TABLE field_definitions DROP CONSTRAINT chk_field_definitions_module_key;
ALTER TABLE field_definitions ADD CONSTRAINT chk_field_definitions_module_key
  CHECK (module_key = ANY (ARRAY[
    'orders','products','order_line_items','customs','shipping','finance',
    'shipping_plans','companies','service_rates'
  ]));
