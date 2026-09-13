-- M116-20260913-tariff-container-type-fk.sql
-- carrier_tariff_standards.container_type 原来是写死三个值的 CHECK(20GP/40GP/40HQ)，
-- 冷冻柜(20RF/40RH…)根本进不来。换成引用 container_types 字典的外键：
-- 值域从"改约束"变成"往字典加一行"，以后加箱型不用再动 DDL。
-- 现有 654 行的值全是 20GP/40GP/40HQ，都在字典里，不会有行被拒。
BEGIN;
-- 先验：有没有不在字典里的值（有就中止，绝不静默丢数据）
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad FROM carrier_tariff_standards t
   WHERE t.container_type IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM container_types c WHERE c.code = t.container_type);
  IF bad > 0 THEN
    RAISE EXCEPTION 'M116 中止：carrier_tariff_standards 有 % 行的 container_type 不在 container_types 字典里，先补字典再迁移', bad;
  END IF;
END $$;

ALTER TABLE carrier_tariff_standards DROP CONSTRAINT IF EXISTS carrier_tariff_standards_container_type_check;
ALTER TABLE carrier_tariff_standards
  ADD CONSTRAINT carrier_tariff_standards_container_type_fkey
  FOREIGN KEY (container_type) REFERENCES container_types(code);
COMMIT;
