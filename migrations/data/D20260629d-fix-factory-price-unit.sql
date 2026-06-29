-- D20260629d 工厂价单位修正: factory_price=master每支×bg_bx (Damon确认产品库工厂价可信)
-- 仅改: master存在 + bg_bx>1 + unit_price是每箱(>=master*bg_bx*0.5) + (空 或 =master每支单位bug) + 排除6烂账单
-- 跳过: B类(unit也每支)/C类(模糊)/人工录的其它/烂账单。同步重算factory_subtotal。幂等。
BEGIN;
CREATE TABLE IF NOT EXISTS _bak_oli_facprice_20260629 AS
  SELECT li.id, li.order_id, li.sku, li.bg_bx, li.unit_price, li.factory_price, li.factory_subtotal
  FROM order_line_items li JOIN products p ON p.sku=li.sku
  WHERE p.factory_price IS NOT NULL AND li.bg_bx>1
    AND li.unit_price >= p.factory_price*li.bg_bx*0.5
    AND (coalesce(li.factory_price,0)=0 OR abs(li.factory_price - p.factory_price) < 0.01)
    AND li.order_id NOT IN (select id from orders where order_no in
        ('37-ZC-20','37-ZC-16','40-PBXCD-20260205','48-CL-10','32-PBLSQ-20260115','40-CP-2'));

UPDATE order_line_items li
   SET factory_price = round(p.factory_price*li.bg_bx, 4),
       factory_subtotal = round(li.qty_ctn * p.factory_price * li.bg_bx, 2),
       updated_at = NOW()
  FROM products p
 WHERE p.sku=li.sku AND p.factory_price IS NOT NULL AND li.bg_bx>1
   AND li.unit_price >= p.factory_price*li.bg_bx*0.5
   AND (coalesce(li.factory_price,0)=0 OR abs(li.factory_price - p.factory_price) < 0.01)
   AND li.order_id NOT IN (select id from orders where order_no in
       ('37-ZC-20','37-ZC-16','40-PBXCD-20260205','48-CL-10','32-PBLSQ-20260115','40-CP-2'));
COMMIT;
