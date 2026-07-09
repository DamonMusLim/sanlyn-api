-- D20260629e 食品HS录错修正: 5单(37-WP-55/37-ZC-17/37-ZC-19/38-WP-57/40-CP-3)宠物食品被错配3926/3924塑料HS
-- 改回产品主表的2309食品HS(同SKU其它订单行+主表一致为证)+退税率0.09。Damon授权"改回,有对应报关单"。
-- 仅改这5单里 hs IN(3926909090,3924100000) 且主表有2309的行。配件单(DG/PBXCD)不碰。
BEGIN;
CREATE TABLE IF NOT EXISTS _bak_oli_foodhs_20260629 AS
  SELECT id, order_id, sku, hs_code, tax_rebate_rate, vat_rate FROM order_line_items
  WHERE order_id IN (select id from orders where order_no in ('37-WP-55','37-ZC-17','37-ZC-19','38-WP-57','40-CP-3'))
    AND hs_code IN ('3926909090','3924100000');

WITH master_hs AS (
  SELECT sku, hs_code,
         row_number() OVER (PARTITION BY sku ORDER BY (hs_code LIKE '2309%') DESC, count(*) DESC) rn
  FROM products WHERE hs_code IS NOT NULL GROUP BY sku, hs_code
)
UPDATE order_line_items li
   SET hs_code = m.hs_code, tax_rebate_rate = 0.09,
       vat_rate = COALESCE(NULLIF(li.vat_rate,0),0.13), updated_at = NOW()
  FROM master_hs m
 WHERE m.sku = li.sku AND m.rn = 1 AND m.hs_code LIKE '2309%'
   AND li.order_id IN (select id from orders where order_no in ('37-WP-55','37-ZC-17','37-ZC-19','38-WP-57','40-CP-3'))
   AND li.hs_code IN ('3926909090','3924100000');
COMMIT;
