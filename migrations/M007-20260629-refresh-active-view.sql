-- M007: 刷新 active_freight_supplier_bills 视图，纳入 M006 新增的 ap/ar 付款状态列。
-- 背景：M005 把视图建成显式列清单(SELECT * 被展开)，给基表 ADD COLUMN 不会自动进视图，
-- 导致 bill-center 读视图时 ap_status/ar_status 不存在。改回 SELECT * 并面向未来自动纳列。
-- CREATE OR REPLACE 允许在原列清单末尾追加新列(顺序/类型不变)，幂等安全。
CREATE OR REPLACE VIEW active_freight_supplier_bills AS
  SELECT *
    FROM freight_supplier_bills
   WHERE COALESCE(rebill_status, ''::text) <> 'voided'::text;
