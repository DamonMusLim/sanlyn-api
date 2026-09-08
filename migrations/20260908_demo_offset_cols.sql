ALTER TABLE demo.forwarder_shipping_plans
  ADD COLUMN IF NOT EXISTS etd_offset_days integer,
  ADD COLUMN IF NOT EXISTS delivery_offset_days integer,
  ADD COLUMN IF NOT EXISTS eta_offset_days integer;

COMMENT ON COLUMN demo.forwarder_shipping_plans.etd_offset_days IS
  '演示用相对今天 ETD 偏移天数;读取时按服务器本地日现算,原 etd 绝对日期保留为空给真实数据';
COMMENT ON COLUMN demo.forwarder_shipping_plans.delivery_offset_days IS
  '演示用相对今天货好/交期偏移天数;读取时按服务器本地日现算';
COMMENT ON COLUMN demo.forwarder_shipping_plans.eta_offset_days IS
  '演示用相对今天 ETA 偏移天数;读取时按服务器本地日现算,原 eta 绝对日期保留为空给真实数据';
