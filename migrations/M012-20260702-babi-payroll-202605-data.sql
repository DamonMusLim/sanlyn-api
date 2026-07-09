-- D-20260702 BABI 2026-05 工资并入财务成本(Damon 2026-07-02批,走migration不开写权限)
-- 幂等:按 created_by=payroll-sync + record_no 先删后插;金额全部聚合自 payroll_sheets,无手编数字
DELETE FROM finance_records
 WHERE created_by = 'payroll-sync'
   AND record_no IN (SELECT 'PR-'||company_id||'-'||period_id FROM payroll_sheets);

-- 2) 按 公司+月份 聚合重插
INSERT INTO finance_records
  (record_no, direction, category, status, currency, amount, paid_amount,
   counterparty, issuing_company, issuing_code, due_date, paid_date, raw,
   created_by, created_at, updated_at)
SELECT
  'PR-'||company_id||'-'||period_id                           AS record_no,
  'out'                                                       AS direction,
  '工资'                                                       AS category,
  CASE WHEN bool_or(paid_status='PAID') THEN 'paid' ELSE 'pending' END AS status,
  'CNY'                                                       AS currency,
  -- 公司总用工成本 = 应发 + 企业承担五险一金
  sum(gross_pay)
    + sum(employer_social_insurance + employer_medical_insurance + employer_housing_fund) AS amount,
  sum(bank_amount)                                            AS paid_amount,
  count(*)||'人·工资'                                          AS counterparty,
  CASE company_id WHEN 'co-babi'      THEN '厦门巴匕进出口有限公司'
                  WHEN 'co-oceanbaby' THEN '上海洋宝宝国际物流有限公司'
                  ELSE company_id END                          AS issuing_company,
  CASE company_id WHEN 'co-babi'      THEN 'BABI'
                  WHEN 'co-oceanbaby' THEN 'SHYBB'
                  ELSE upper(replace(company_id,'co-','')) END  AS issuing_code,
  (period_id||'-28')::date                                    AS due_date,
  max(paid_at)::date                                          AS paid_date,
  jsonb_build_object(
    'headcount',         count(*),
    'gross',             sum(gross_pay),
    'net',               sum(net_pay),
    'personal_withhold', sum(personal_social_insurance + personal_medical_insurance
                             + personal_housing_fund + personal_tax + coalesce(unemployment_insurance,0)),
    'employer_contrib',  sum(employer_social_insurance + employer_medical_insurance + employer_housing_fund),
    'bank_amount',       sum(bank_amount),
    'source',            'payroll_sheets'
  )                                                           AS raw,
  'payroll-sync'                                              AS created_by,
  now(), now()
FROM payroll_sheets
GROUP BY company_id, period_id;