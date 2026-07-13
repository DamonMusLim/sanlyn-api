-- M028: customs_invoice_status 主键 (customs_no) → 复合 (customs_no, factory_code)
-- 背景: 一票多厂(如 BL 140601772471 = VEN-DS + FAC-014 + VEN-LL)单键只能存一行 status,
--       其余厂永远无法各自确认金额/走开票流程。forge-1783963591351-1gp3
-- 前置: ①回填 invoice_customs_links.factory_code(11条历史手工挂链为NULL,全属单厂关单,
--       趁 status 仍单键按 customs_no 一对一回填,安全);
--       ②孤儿行 021720260000046610(fer 合同 PBTYF-20260104,无订单挂靠,全字段空白)删除——
--       零信息行,fer 真源不动;厂别归属仅有推测无铁证,按数据真实铁律不造数。

UPDATE invoice_customs_links l
   SET factory_code = s.factory_code
  FROM customs_invoice_status s
 WHERE l.factory_code IS NULL
   AND s.customs_no = l.customs_no
   AND s.factory_code IS NOT NULL;

DELETE FROM customs_invoice_status
 WHERE customs_no = '021720260000046610'
   AND factory_code IS NULL;

ALTER TABLE customs_invoice_status
  ALTER COLUMN factory_code SET NOT NULL;

ALTER TABLE customs_invoice_status
  DROP CONSTRAINT IF EXISTS customs_invoice_status_pkey;

ALTER TABLE customs_invoice_status
  ADD CONSTRAINT customs_invoice_status_pkey PRIMARY KEY (customs_no, factory_code);
