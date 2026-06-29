-- D20260629f 配件退税率: Damon定按13%(制成品,finance历史69笔=13%,权威表HS来自真实放行报关单)
-- ①填customs_hs_authority空rate ②3单配件OLI退税率=0.13
BEGIN;
-- ① 权威表填值(仅空的)
UPDATE customs_hs_authority SET rebate_rate=0.13, updated_at=NOW()
 WHERE regexp_replace(hs_code,'[^0-9]','','g') IN ('3926909090','4201000090','6307909000','7324900000')
   AND rebate_rate IS NULL;
-- ② 3单配件行
CREATE TABLE IF NOT EXISTS _bak_oli_accrate_20260629 AS
  SELECT id, order_id, sku, hs_code, tax_rebate_rate, vat_rate FROM order_line_items
  WHERE order_id IN (select id from orders where order_no in ('40-DG-3','40-DG-4','40-PBXCD-20260205'))
    AND coalesce(tax_rebate_rate,0)=0 and coalesce(declare_amount_per_box,0)>0;
UPDATE order_line_items
   SET tax_rebate_rate=0.13, vat_rate=COALESCE(NULLIF(vat_rate,0),0.13), updated_at=NOW()
 WHERE order_id IN (select id from orders where order_no in ('40-DG-3','40-DG-4','40-PBXCD-20260205'))
   AND coalesce(tax_rebate_rate,0)=0 and coalesce(declare_amount_per_box,0)>0;
COMMIT;
