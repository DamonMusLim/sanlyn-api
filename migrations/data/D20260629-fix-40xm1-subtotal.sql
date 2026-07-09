-- D20260629 数据修正: 40-XM-1(订单1220/BL AXI0361194)改箱数后明细小计未重算
-- 根因: order-line-items PATCH只更qty_ctn未重算subtotal(代码已同步修)。Claude诊断+Damon本对话授权"全修"。
-- 仅修这一票+其海运plan聚合; 其余18单drift为录入烂账,另列人工核发票,不在此动。
-- 纯重算,幂等可重跑。
BEGIN;
CREATE TABLE IF NOT EXISTS _bak_oli_1220_20260629 AS SELECT * FROM order_line_items WHERE order_id=1220;
CREATE TABLE IF NOT EXISTS _bak_sp_437_20260629  AS SELECT * FROM shipping_plans   WHERE id=437;

UPDATE order_line_items
   SET subtotal         = ROUND(qty_ctn*unit_price,2),
       factory_subtotal = ROUND(qty_ctn*factory_price,2),
       updated_at = NOW()
 WHERE order_id=1220;

UPDATE orders o
   SET total_amount = sub.s, updated_at = NOW()
  FROM (SELECT order_id, SUM(subtotal) s FROM order_line_items WHERE order_id=1220 GROUP BY order_id) sub
 WHERE o.id = sub.order_id;

UPDATE shipping_plans sp
   SET total_cartons   = agg.cartons,
       gross_weight_kg = agg.gw,
       total_cbm       = agg.cbm,
       updated_at = NOW()
  FROM (SELECT SUM(qty_ctn) cartons,
               ROUND(SUM(qty_ctn*gw_ctn),2)  gw,
               ROUND(SUM(qty_ctn*cbm_ctn),3) cbm
        FROM order_line_items WHERE order_id=1220) agg
 WHERE sp.id = 437;
COMMIT;
