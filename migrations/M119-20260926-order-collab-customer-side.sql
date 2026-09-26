-- 订单协同 · 客户版（Damon 0926：客户和巴匕同一个模板，只是主题不同）
-- 同一张订单可以同时有一张工厂协同单（side=factory，采购合同）和一张客户协同单（side=customer，PI）。
-- 只加列、换唯一索引；⛔ 不改任何现有数据：已有的单 side 默认 factory。幂等，可重跑。
ALTER TABLE collab.po_sheet ADD COLUMN IF NOT EXISTS side text NOT NULL DEFAULT 'factory';
ALTER TABLE collab.po_sheet ADD COLUMN IF NOT EXISTS party_company_id integer;   -- 客户版=客户 companies.id
ALTER TABLE collab.po_sheet ADD COLUMN IF NOT EXISTS party_request jsonb;        -- 客户版：要求交期/唛头/备注等修改申请
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'po_sheet_side_chk') THEN
    ALTER TABLE collab.po_sheet ADD CONSTRAINT po_sheet_side_chk CHECK (side IN ('factory','customer'));
  END IF;
END $$;
-- 原来「一张订单只能有一张非作废协同单」→ 改成「每一边各一张」
CREATE UNIQUE INDEX IF NOT EXISTS po_sheet_live_uniq_side ON collab.po_sheet (order_no, side) WHERE status <> 'void';
DROP INDEX IF EXISTS collab.po_sheet_live_uniq;
CREATE INDEX IF NOT EXISTS po_sheet_party_idx ON collab.po_sheet (party_company_id) WHERE party_company_id IS NOT NULL;
