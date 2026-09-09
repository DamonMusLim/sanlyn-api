-- 采购单补果冻橙计划单号字段。
-- 背景: 果冻橙采购单接口返回 planOrderNo, 用于把要货单闭环追到采购计划。
-- 说明: requireGoodsOrderNo 复用现有 petstore_purchase_orders.doc_ref, 本迁移只新增 plan_no。

BEGIN;

ALTER TABLE public.petstore_purchase_orders
  ADD COLUMN IF NOT EXISTS plan_no text;

COMMENT ON COLUMN public.petstore_purchase_orders.plan_no IS
  '果冻橙采购计划单号 planOrderNo；用于关联要货单闭环，允许为空。';

COMMIT;

-- 回滚段:
-- BEGIN;
-- ALTER TABLE public.petstore_purchase_orders
--   DROP COLUMN IF EXISTS plan_no;
-- COMMIT;
