-- M112 · BABI payroll batch skeletons for 2025-11 through 2026-05.
-- Revert: delete hr_payroll rows with note like 'M112:%' after human review.
-- This file does not split bank batches to employees without explicit detail.

SELECT 'M112_before_periods' AS phase, period, COUNT(*) AS rows,
       COUNT(employee_id) AS person_rows,
       SUM(net_amount) AS net_sum
  FROM hr_payroll
 WHERE company_code = 'BABI'
   AND period IN ('2025-11','2026-01','2026-02','2026-03','2026-04','2026-05')
 GROUP BY period
 ORDER BY period;

WITH target(period, bank_amount, paid_at, note) AS (
  VALUES
    ('2025-11', 58612.80::numeric, DATE '2026-01-14', 'M112: 含2025-12，合并批不可等分；银行实付=代发36478.98+邱楚涵22133.82'),
    ('2026-01', 51978.98::numeric, DATE '2026-02-13', 'M112: 银行实付=代发40978.98+邱楚涵11000'),
    ('2026-02', 56629.69::numeric, DATE '2026-03-19', 'M112: 银行实付=代发37629.69+邱楚涵11000+李一鸣8000'),
    ('2026-03', 53411.30::numeric, DATE '2026-04-16', 'M112: 银行实付=代发37411.30+李一鸣8000+邱楚涵8000'),
    ('2026-04', 53411.30::numeric, DATE '2026-07-09', 'M112: 2026-07-09合并批160233.90三期之一'),
    ('2026-05', 53411.30::numeric, DATE '2026-07-09', 'M112: 2026-07-09合并批160233.90三期之一')
)
INSERT INTO hr_payroll
  (company_code, employee_id, employee_name, period, pay_type, pay_rate,
   scheduled_days, actual_days, actual_hours, leave_days, overtime_hours,
   base_amount, overtime_amount, commission_amount, deduction_amount, reimb_amount,
   gross_amount, net_amount, tax_amount, status, note, paid_at, created_at)
SELECT 'BABI', NULL, NULL, period, 'batch', 0,
       0, 0, 0, 0, 0,
       0, 0, 0, 0, 0,
       NULL, bank_amount, NULL, 'imported', note, paid_at, now()
  FROM target t
 WHERE NOT EXISTS (
       SELECT 1 FROM hr_payroll p
        WHERE p.company_code = 'BABI'
          AND p.period = t.period
 );

SELECT 'M112_after_periods' AS phase, period, COUNT(*) AS rows,
       COUNT(employee_id) AS person_rows,
       SUM(net_amount) AS net_sum,
       STRING_AGG(COALESCE(employee_name, '<batch>'), ',' ORDER BY employee_name NULLS FIRST) AS names
  FROM hr_payroll
 WHERE company_code = 'BABI'
   AND period IN ('2025-11','2026-01','2026-02','2026-03','2026-04','2026-05','2026-06')
 GROUP BY period
 ORDER BY period;
