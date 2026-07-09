-- D20260629b 数据修正: 12单"干净stale"明细小计对齐(表头总额已=箱数×单价,仅明细未同步)
-- order_id: 25,29,30,40,44,49,51,57,71,1168,1173,1185 (34-PBTDP/37-WP-52/38-WP-57/37-XM-243/
--   37-XM-247/38-XM-253/37-XM-255/38-XM-261/40-CL-11/42-DG-1/40-DG-2/40-CP-6)
-- 仅重算subtotal/factory_subtotal(unit_price/factory_price为空的行不动)。幂等可重跑。
-- 不含6单真烂账(48-CL-10/37-ZC-20/40-PBXCD/37-ZC-16/32-PBLSQ/40-CP-2),留人工核发票。
BEGIN;
CREATE TABLE IF NOT EXISTS _bak_oli_safe12_20260629 AS
  SELECT * FROM order_line_items WHERE order_id IN (25,29,30,40,44,49,51,57,71,1168,1173,1185);
UPDATE order_line_items
   SET subtotal = CASE WHEN unit_price IS NOT NULL THEN ROUND(qty_ctn*unit_price,2) ELSE subtotal END,
       factory_subtotal = CASE WHEN factory_price IS NOT NULL THEN ROUND(qty_ctn*factory_price,2) ELSE factory_subtotal END,
       updated_at = NOW()
 WHERE order_id IN (25,29,30,40,44,49,51,57,71,1168,1173,1185);
COMMIT;
