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
-- ⚠️ 客户单（side='customer'）复用 factory_name 这一列存【客户公司名】（对方公司名），不是工厂。按工厂查请一律加 side='factory'。
COMMENT ON COLUMN collab.po_sheet.factory_name IS '对方公司名：side=factory 时是工厂名；side=customer 时是客户公司名（订单协同客户版）';
COMMENT ON COLUMN collab.po_sheet.side IS 'factory=采购单协同（巴匕买、工厂卖）；customer=订单协同客户版 PI（巴匕卖、客户买）';
