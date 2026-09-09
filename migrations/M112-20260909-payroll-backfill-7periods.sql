-- M112 · BABI payroll batch skeletons for 2025-11 through 2026-05.
-- Revert: delete hr_payroll rows with note like 'M112:%' after human review.
-- This file does not split bank batches to employees without explicit detail.

SELECT 'M112_before_periods' AS phase, period, COUNT(*) AS rows,
       COUNT(employee_id) AS person_rows,
       SUM(net_amount) AS net_sum
  FROM hr_payroll
 WHERE company_code = 'BABI'
   AND period IN ('2025-11','2025-12','2026-01','2026-02','2026-03','2026-04','2026-05')
 GROUP BY period
 ORDER BY period;

WITH target(period, bank_amount, note) AS (
  VALUES
    ('2025-11', 36478.98::numeric, 'M112: 明细待拆·银行合并划转不拆人'),
    ('2025-12', 40978.98::numeric, 'M112: 明细待拆·银行合并划转不拆人'),
    ('2026-01', 37629.69::numeric, 'M112: 明细待拆·银行合并划转不拆人'),
    ('2026-02', 37629.69::numeric, 'M112: 明细待拆·银行合并划转不拆人；brief未单列第4个金额，沿用同组银行批次金额待人工复核'),
    ('2026-03', 37411.30::numeric, 'M112: 五人口径可拆但本仓未随附人级明细，先建批次级骨架，禁止月均硬摊'),
    ('2026-04', 37411.30::numeric, 'M112: 五人口径可拆但本仓未随附人级明细，先建批次级骨架，禁止月均硬摊'),
    ('2026-05', 37411.30::numeric, 'M112: 五人口径可拆但本仓未随附人级明细，先建批次级骨架，禁止月均硬摊')
)
INSERT INTO hr_payroll
  (company_code, employee_id, employee_name, period, pay_type, pay_rate,
   scheduled_days, actual_days, actual_hours, leave_days, overtime_hours,
   base_amount, overtime_amount, commission_amount, deduction_amount, reimb_amount,
   gross_amount, net_amount, tax_amount, status, note, created_at, updated_at)
SELECT 'BABI', NULL, NULL, period, 'batch', 0,
       0, 0, 0, 0, 0,
       bank_amount, 0, 0, 0, 0,
       bank_amount, bank_amount, NULL, 'confirmed', note, now(), now()
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
   AND period IN ('2025-11','2025-12','2026-01','2026-02','2026-03','2026-04','2026-05','2026-06')
 GROUP BY period
 ORDER BY period;
