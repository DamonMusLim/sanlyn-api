-- D20260629c OLI退税率/增值税率回填(为resync做准备,OLI成完整SSOT)
-- 源: customs_hs_authority(按8位HS) + 2309系=9%(HS铁律宠物食品);非食品查不到的HS留空待人工核。
-- 仅补 tax_rebate_rate=0 且 declare_amount_per_box>0 的行。幂等。
BEGIN;
CREATE TABLE IF NOT EXISTS _bak_oli_rate_20260629 AS
  SELECT id, order_id, sku, hs_code, tax_rebate_rate, vat_rate
  FROM order_line_items WHERE coalesce(tax_rebate_rate,0)=0 and coalesce(declare_amount_per_box,0)>0;

-- 1) 权威表匹配(8位HS)
WITH auth AS (
  SELECT left(regexp_replace(hs_code,'[^0-9]','','g'),8) hs8, max(rebate_rate) rate
  FROM customs_hs_authority WHERE rebate_rate IS NOT NULL GROUP BY 1
)
UPDATE order_line_items li
   SET tax_rebate_rate = auth.rate, updated_at=NOW()
  FROM auth
 WHERE coalesce(li.tax_rebate_rate,0)=0 AND coalesce(li.declare_amount_per_box,0)>0
   AND left(regexp_replace(li.hs_code,'[^0-9]','','g'),8) = auth.hs8;

-- 2) 2309系仍为空的 → 0.09(宠物食品铁律)
UPDATE order_line_items
   SET tax_rebate_rate = 0.09, updated_at=NOW()
 WHERE coalesce(tax_rebate_rate,0)=0 AND coalesce(declare_amount_per_box,0)>0
   AND left(regexp_replace(hs_code,'[^0-9]','','g'),4)='2309';

-- 3) vat_rate 补 0.13(货物标准),仅对已补到退税率的行
UPDATE order_line_items
   SET vat_rate = 0.13, updated_at=NOW()
 WHERE coalesce(vat_rate,0)=0 AND coalesce(tax_rebate_rate,0)>0 AND coalesce(declare_amount_per_box,0)>0;
COMMIT;
