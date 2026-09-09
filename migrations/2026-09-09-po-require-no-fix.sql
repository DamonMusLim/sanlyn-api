-- 果冻橙采购单: requireGoodsOrderNo 是要货单号。
-- 一张要货单会按供应商拆成多张采购单, 所以 require_no 只能建普通索引, 不能唯一。
-- 不修改 petstore_purchase_orders(store_code, doc_ref) 的唯一约束; doc_ref 保持原用途。

BEGIN;

ALTER TABLE public.petstore_purchase_orders
  ADD COLUMN IF NOT EXISTS require_no text;

COMMENT ON COLUMN public.petstore_purchase_orders.require_no IS
  '果冻橙要货单号 requireGoodsOrderNo; 一张要货单可拆成多张采购单, 一对多, 故不唯一。';

CREATE INDEX IF NOT EXISTS idx_po_require_no
  ON public.petstore_purchase_orders (require_no);

COMMIT;

-- 回滚段(需要回滚时手工执行):
-- BEGIN;
-- DROP INDEX IF EXISTS public.idx_po_require_no;
-- ALTER TABLE public.petstore_purchase_orders DROP COLUMN IF EXISTS require_no;
-- COMMIT;
