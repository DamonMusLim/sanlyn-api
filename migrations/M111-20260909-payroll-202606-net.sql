-- M111 · BABI payroll 2026-06 net pay + receivable differences.
-- Revert: delete finance_records where created_by='payroll-m111' and record_no like 'PAY-M111-%',
-- then restore hr_payroll 2026-06 from pre-migration backup if human review requires rollback.

SELECT 'M111_before_payroll' AS phase, employee_id, employee_name, period,
       gross_amount, net_amount, tax_amount, note
  FROM hr_payroll
 WHERE company_code = 'BABI'
   AND period = '2026-06'
 ORDER BY employee_name NULLS LAST;

WITH target(employee_name, gross_amount, net_amount, tax_amount, note) AS (
  VALUES
    ('林志凌', 12000.00::numeric, 10911.21::numeric, 656.47::numeric,
     '个税应扣656.47实扣20.03，差636.44 公司垫付'),
    ('崔婷雅', 8000.00::numeric, 7490.74::numeric, 76.94::numeric,
     '五险432.32+个税76.94全未扣，差509.26 公司垫付·无还款台账'),
    ('邱楚涵', 8000.00::numeric, 8000.00::numeric, 76.95::numeric,
     '社保另收(台账)·个税76.95未扣'),
    ('李美倩', 8000.00::numeric, 8000.00::numeric, NULL::numeric,
     '社保另收(台账)·个税NULL待算·缺 01~05 期累计'),
    ('林彩云', 5400.00::numeric, 4967.68::numeric, 0.00::numeric,
     '应发由8800改5400(0909 Damon定,2026-06起)；银行按8800档实付8363.65，多发3395.97'),
    ('邹瞻舒', 5000.00::numeric, 5000.00::numeric, NULL::numeric,
     '社保另收(台账)·个税NULL待算·缺 01~05 期累计'),
    ('潘秀文', 4500.00::numeric, 4500.00::numeric, 0.00::numeric,
     '超龄不参保'),
    ('李一鸣', 0.00::numeric, 0.00::numeric, NULL::numeric,
     '已离职·本期收入0；个税NULL待算·缺 01~05 期累计')
)
UPDATE hr_payroll p
   SET gross_amount = t.gross_amount,
       base_amount = t.gross_amount,
       net_amount = t.net_amount,
       tax_amount = t.tax_amount,
       note = t.note,
       updated_at = now()
  FROM target t
 WHERE p.company_code = 'BABI'
   AND p.period = '2026-06'
   AND p.employee_name = t.employee_name;

WITH target(employee_name, gross_amount, net_amount, tax_amount, note) AS (
  VALUES
    ('林志凌', 12000.00::numeric, 10911.21::numeric, 656.47::numeric,
     '个税应扣656.47实扣20.03，差636.44 公司垫付'),
    ('崔婷雅', 8000.00::numeric, 7490.74::numeric, 76.94::numeric,
     '五险432.32+个税76.94全未扣，差509.26 公司垫付·无还款台账'),
    ('邱楚涵', 8000.00::numeric, 8000.00::numeric, 76.95::numeric,
     '社保另收(台账)·个税76.95未扣'),
    ('李美倩', 8000.00::numeric, 8000.00::numeric, NULL::numeric,
     '社保另收(台账)·个税NULL待算·缺 01~05 期累计'),
    ('林彩云', 5400.00::numeric, 4967.68::numeric, 0.00::numeric,
     '应发由8800改5400(0909 Damon定,2026-06起)；银行按8800档实付8363.65，多发3395.97'),
    ('邹瞻舒', 5000.00::numeric, 5000.00::numeric, NULL::numeric,
     '社保另收(台账)·个税NULL待算·缺 01~05 期累计'),
    ('潘秀文', 4500.00::numeric, 4500.00::numeric, 0.00::numeric,
     '超龄不参保'),
    ('李一鸣', 0.00::numeric, 0.00::numeric, NULL::numeric,
     '已离职·本期收入0；个税NULL待算·缺 01~05 期累计')
),
src AS (
  SELECT t.*, e.id AS employee_id, COALESCE(e.pay_type, 'monthly') AS pay_type,
         COALESCE(e.pay_rate, t.gross_amount) AS pay_rate
    FROM target t
    LEFT JOIN hr_employees e
      ON e.company_code = 'BABI'
     AND e.name = t.employee_name
)
INSERT INTO hr_payroll
  (company_code, employee_id, employee_name, period, pay_type, pay_rate,
   scheduled_days, actual_days, actual_hours, leave_days, overtime_hours,
   base_amount, overtime_amount, commission_amount, deduction_amount, reimb_amount,
   gross_amount, net_amount, tax_amount, status, note, created_at, updated_at)
SELECT 'BABI', employee_id, employee_name, '2026-06', pay_type, pay_rate,
       0, 0, 0, 0, 0,
       gross_amount, 0, 0, 0, 0,
       gross_amount, net_amount, tax_amount, 'confirmed', note, now(), now()
  FROM src s
 WHERE NOT EXISTS (
       SELECT 1 FROM hr_payroll p
        WHERE p.company_code = 'BABI'
          AND p.period = '2026-06'
          AND p.employee_name = s.employee_name
 );

DELETE FROM finance_records
 WHERE created_by = 'payroll-m111'
   AND record_no IN ('PAY-M111-202606-LINCY-OVERPAID', 'PAY-M111-202606-WITHHELD-ADVANCE');

INSERT INTO finance_records
  (record_no, direction, category, status, currency, amount, paid_amount,
   counterparty, counterparty_code, issuing_company, issuing_code, due_date,
   raw, created_by, created_at, updated_at)
VALUES
  ('PAY-M111-202606-LINCY-OVERPAID', 'AR', '其他应收款', 'pending', 'CNY', 3395.97, 0,
   '林彩云', NULL, '厦门巴匕进出口有限公司', 'BABI', DATE '2026-06-30',
   jsonb_build_object('source','M111','period','2026-06','reason','银行按8800档实付8363.65，应发5400档实发4967.68，多发3395.97'),
   'payroll-m111', now(), now()),
  ('PAY-M111-202606-WITHHELD-ADVANCE', 'AR', '工资垫付', 'pending', 'CNY', 1145.70, 0,
   '林志凌/崔婷雅', NULL, '厦门巴匕进出口有限公司', 'BABI', DATE '2026-06-30',
   jsonb_build_object('source','M111','period','2026-06','林志凌',636.44,'崔婷雅',509.26,'reason','应扣未扣，公司垫付，无还款台账'),
   'payroll-m111', now(), now());

SELECT 'M111_after_payroll' AS phase, employee_id, employee_name, period,
       gross_amount, net_amount, tax_amount, note
  FROM hr_payroll
 WHERE company_code = 'BABI'
   AND period = '2026-06'
 ORDER BY employee_name NULLS LAST;

SELECT 'M111_after_finance_records' AS phase, record_no, direction, category,
       status, currency, amount, paid_amount, counterparty, issuing_code
  FROM finance_records
 WHERE created_by = 'payroll-m111'
   AND record_no LIKE 'PAY-M111-%'
 ORDER BY record_no;
