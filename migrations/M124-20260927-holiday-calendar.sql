-- M124 · 法定假日日历 + 店内放假计划
-- 只种 brief 指定日期；国办正式通知发布后再由人工补迁移核对。

CREATE TABLE IF NOT EXISTS hr_public_holidays (
  holiday_date DATE PRIMARY KEY,
  year INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('legal','makeup_work')),
  name TEXT NOT NULL,
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_hr_public_holidays_year_kind
  ON hr_public_holidays(year, kind, holiday_date);

CREATE TABLE IF NOT EXISTS hr_store_holiday_plans (
  id SERIAL PRIMARY KEY,
  company_code TEXT NOT NULL,
  name TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  note TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT hr_store_holiday_plans_range_ck CHECK (end_date >= start_date)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_store_holiday_plans_dedupe
  ON hr_store_holiday_plans(company_code, name, start_date, end_date);

ALTER TABLE hr_payroll ADD COLUMN IF NOT EXISTS holiday_work_days NUMERIC DEFAULT 0;
ALTER TABLE hr_payroll ADD COLUMN IF NOT EXISTS holiday_amount NUMERIC DEFAULT 0;
ALTER TABLE hr_payroll ADD COLUMN IF NOT EXISTS holiday_paid_days NUMERIC DEFAULT 0;
ALTER TABLE hr_payroll ADD COLUMN IF NOT EXISTS store_paid_days NUMERIC DEFAULT 0;

ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS employment_type TEXT CHECK (employment_type IN ('fulltime','parttime'));
UPDATE hr_employees
   SET employment_type = CASE WHEN pay_type = 'monthly' THEN 'fulltime' ELSE 'parttime' END
 WHERE employment_type IS NULL;

ALTER TABLE hr_org_settings ADD COLUMN IF NOT EXISTS holiday_multiplier NUMERIC DEFAULT 3;

ALTER TABLE hr_day_agenda ADD COLUMN IF NOT EXISTS employee_id INTEGER;
ALTER TABLE hr_day_agenda ADD COLUMN IF NOT EXISTS employee_name TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_day_agenda_holiday_notice_dedupe
  ON hr_day_agenda(company_code, work_date, kind, employee_id, title)
  WHERE kind='notice' AND employee_id IS NOT NULL;

INSERT INTO hr_public_holidays (holiday_date, year, kind, name, note) VALUES
  (DATE '2026-01-01', 2026, 'legal', '元旦', NULL),
  (DATE '2026-02-16', 2026, 'legal', '春节', NULL),
  (DATE '2026-02-17', 2026, 'legal', '春节', NULL),
  (DATE '2026-02-18', 2026, 'legal', '春节', NULL),
  (DATE '2026-02-19', 2026, 'legal', '春节', NULL),
  (DATE '2026-04-05', 2026, 'legal', '清明', NULL),
  (DATE '2026-05-01', 2026, 'legal', '劳动节', NULL),
  (DATE '2026-05-02', 2026, 'legal', '劳动节', NULL),
  (DATE '2026-06-19', 2026, 'legal', '端午', NULL),
  (DATE '2026-09-25', 2026, 'legal', '中秋', NULL),
  (DATE '2026-10-01', 2026, 'legal', '国庆', NULL),
  (DATE '2026-10-02', 2026, 'legal', '国庆', NULL),
  (DATE '2026-10-03', 2026, 'legal', '国庆', NULL),
  (DATE '2026-09-20', 2026, 'makeup_work', '国庆调休', NULL),
  (DATE '2026-10-10', 2026, 'makeup_work', '国庆调休', NULL),
  (DATE '2027-01-01', 2027, 'legal', '元旦', '按农历推算,国办通知发布后核对'),
  (DATE '2027-02-05', 2027, 'legal', '春节', '按农历推算,国办通知发布后核对'),
  (DATE '2027-02-06', 2027, 'legal', '春节', '按农历推算,国办通知发布后核对'),
  (DATE '2027-02-07', 2027, 'legal', '春节', '按农历推算,国办通知发布后核对'),
  (DATE '2027-02-08', 2027, 'legal', '春节', '按农历推算,国办通知发布后核对'),
  (DATE '2027-04-05', 2027, 'legal', '清明', '按农历推算,国办通知发布后核对'),
  (DATE '2027-05-01', 2027, 'legal', '劳动节', '按农历推算,国办通知发布后核对'),
  (DATE '2027-05-02', 2027, 'legal', '劳动节', '按农历推算,国办通知发布后核对'),
  (DATE '2027-06-09', 2027, 'legal', '端午', '按农历推算,国办通知发布后核对'),
  (DATE '2027-09-15', 2027, 'legal', '中秋', '按农历推算,国办通知发布后核对'),
  (DATE '2027-10-01', 2027, 'legal', '国庆', '按农历推算,国办通知发布后核对'),
  (DATE '2027-10-02', 2027, 'legal', '国庆', '按农历推算,国办通知发布后核对'),
  (DATE '2027-10-03', 2027, 'legal', '国庆', '按农历推算,国办通知发布后核对')
ON CONFLICT (holiday_date) DO NOTHING;

INSERT INTO hr_store_holiday_plans
  (company_code, name, start_date, end_date, note, created_by)
SELECT 'JINFANG', '国庆', DATE '2026-10-01', DATE '2026-10-05', NULL, 'damon'
WHERE NOT EXISTS (
  SELECT 1 FROM hr_store_holiday_plans
   WHERE company_code='JINFANG' AND name='国庆'
     AND start_date=DATE '2026-10-01' AND end_date=DATE '2026-10-05'
);
