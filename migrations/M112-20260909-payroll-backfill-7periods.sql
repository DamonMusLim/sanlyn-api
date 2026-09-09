-- M112 · BABI payroll batch records for 2025-11 through 2026-05.
-- Revert: delete finance_records where created_by='payroll-m112' and record_no like 'PR-BABI-%' after human review.
-- This file records bank-paid payroll batches in finance_records and does not create person payroll rows.

SELECT 'M112_before_finance_records' AS phase, record_no, direction, category,
       status, currency, amount, paid_amount, counterparty, issuing_code, paid_date
  FROM finance_records
 WHERE record_no LIKE 'PR-BABI-%'
    OR record_no = 'PR-co-babi-2026-05'
 ORDER BY record_no;

DELETE FROM finance_records
 WHERE created_by = 'payroll-m112'
   AND record_no LIKE 'PR-BABI-%';

INSERT INTO finance_records
  (record_no, direction, category, status, currency, amount, paid_amount,
   counterparty, issuing_company, issuing_code, due_date, paid_date, raw,
   created_by, created_at, updated_at)
VALUES
  ('PR-BABI-2026-11-12', 'out', '工资', 'pending', 'CNY', 58612.80, 58612.80,
   '工资批次·明细待拆', '厦门巴匕进出口有限公司', 'BABI', DATE '2026-01-14', DATE '2026-01-14',
   jsonb_build_object('source','M112','period','2025-11+12','merged_periods',jsonb_build_array('2025-11','2025-12'),'headcount',NULL,'bank_paid',58612.80,'paid_date','2026-01-14','composition','代发36478.98+邱楚涵22133.82','splittable',false,'vouchers',jsonb_build_array('OBSS003706475198','OBSS003706476486')),
   'payroll-m112', now(), now()),
  ('PR-BABI-2026-01', 'out', '工资', 'pending', 'CNY', 51978.98, 51978.98,
   '工资批次·明细待拆', '厦门巴匕进出口有限公司', 'BABI', DATE '2026-02-13', DATE '2026-02-13',
   jsonb_build_object('source','M112','period','2026-01','headcount',NULL,'bank_paid',51978.98,'paid_date','2026-02-13','composition','代发40978.98+邱楚涵11000','splittable',false,'vouchers',jsonb_build_array('OBSS003854969415','OBSS003855004197')),
   'payroll-m112', now(), now()),
  ('PR-BABI-2026-02', 'out', '工资', 'pending', 'CNY', 56629.69, 56629.69,
   '工资批次·明细待拆', '厦门巴匕进出口有限公司', 'BABI', DATE '2026-03-19', DATE '2026-03-19',
   jsonb_build_object('source','M112','period','2026-02','headcount',NULL,'bank_paid',56629.69,'paid_date','2026-03-19','composition','代发37629.69+邱楚涵11000+李一鸣8000','splittable',false,'vouchers',jsonb_build_array('OBSS003964907708','OBSS003964902293','OBSS003964901278')),
   'payroll-m112', now(), now()),
  ('PR-BABI-2026-03', 'out', '工资', 'pending', 'CNY', 53411.30, 53411.30,
   '工资批次·3人', '厦门巴匕进出口有限公司', 'BABI', DATE '2026-04-16', DATE '2026-04-16',
   jsonb_build_object('source','M112','period','2026-03','headcount',3,'bank_paid',53411.30,'paid_date','2026-04-16','composition','代发37411.30+李一鸣8000+邱楚涵8000','splittable',true,'vouchers',jsonb_build_array('OBSS004068795955','OBSS004068796302','OBSS004068796223')),
   'payroll-m112', now(), now()),
  ('PR-BABI-2026-04', 'out', '工资', 'pending', 'CNY', 53411.30, 53411.30,
   '工资批次·明细待拆', '厦门巴匕进出口有限公司', 'BABI', DATE '2026-07-09', DATE '2026-07-09',
   jsonb_build_object('source','M112','period','2026-04','headcount',NULL,'bank_paid',53411.30,'paid_date','2026-07-09','composition','2026-07-09合并批160233.90三期之一','splittable',true,'vouchers',jsonb_build_array('OBSS004410130044','OBSS004410130479','OBSS004410130696')),
   'payroll-m112', now(), now()),
  ('PR-BABI-2026-05', 'out', '工资', 'pending', 'CNY', 53411.30, 53411.30,
   '工资批次·明细待拆', '厦门巴匕进出口有限公司', 'BABI', DATE '2026-07-09', DATE '2026-07-09',
   jsonb_build_object('source','M112','period','2026-05','headcount',NULL,'bank_paid',53411.30,'paid_date','2026-07-09','composition','2026-07-09合并批160233.90三期之一','splittable',true,'vouchers',jsonb_build_array('OBSS004410130044','OBSS004410130479','OBSS004410130696')),
   'payroll-m112', now(), now());

SELECT 'M112_after_finance_records' AS phase, record_no, direction, category,
       status, currency, amount, paid_amount, counterparty, issuing_code, paid_date, raw
  FROM finance_records
 WHERE created_by = 'payroll-m112'
   AND record_no LIKE 'PR-BABI-%'
 ORDER BY record_no;
