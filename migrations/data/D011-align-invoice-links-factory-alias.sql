-- D011 (2026-07-14): invoice_customs_links 厂码别名对齐。
-- M028 复合主键后按厂过滤发票,链上 zc-oem(=烟台中宠,companies 与 VEN-ZC 同名同司)
-- 与订单/状态行的 VEN-ZC 对不上,导致中宠 4 月两票已开金额被滤成 0。
-- 只对齐"该关单在 customs_invoice_status 恰有一厂行"的无歧义链。实际命中 2 行(id 2,7)。
UPDATE invoice_customs_links l
   SET factory_code = s.factory_code
  FROM (SELECT customs_no, MAX(factory_code) AS factory_code
          FROM customs_invoice_status GROUP BY customs_no HAVING COUNT(*)=1) s
 WHERE s.customs_no = l.customs_no
   AND l.link_status = 'active'
   AND l.factory_code IS NOT NULL
   AND l.factory_code <> s.factory_code;
