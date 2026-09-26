-- M113 · Transfer 4 HR employees from BABI to OCEANBABY effective 2026-08-01.
-- Default is dry-run.
-- 🩸2026-09-09 止血：原写法 current_setting(...,true)='1' 在未设置时返回 NULL，
--   NULL='1'→NULL，而 IF NOT NULL 不进 THEN，导致「显示 DRY_RUN 却真跑了 LIVE」。
--   已统一改为 COALESCE(...,'0')='1'，显示与执行走同一表达式。 To apply intentionally:
--   SET app.m113_live = '1';
--   \i migrations/M113-20260909-employee-entity-transfer.sql
-- Revert: update the same hr_employees rows back to BABI, employees company_id back to 37,
-- and delete transfer events created_by note/source after human review.

SELECT 'M113_mode' AS phase,
       CASE WHEN COALESCE(current_setting('app.m113_live', true), '0') = '1' THEN 'LIVE' ELSE 'DRY_RUN' END AS mode;

WITH target(name) AS (
  VALUES ('李美倩'), ('林彩云'), ('林志凌'), ('邱楚涵')
)
SELECT 'm113_action' AS row_type, 'hr_employees.company_code' AS target,
       e.id::text AS entity_id, e.name AS employee_name,
       e.company_code AS before_value, 'OCEANBABY' AS after_value
  FROM hr_employees e
  JOIN target t ON t.name = e.name
 WHERE e.company_code = 'BABI'
 ORDER BY e.name;

WITH target(name) AS (
  VALUES ('李美倩'), ('林彩云'), ('林志凌'), ('邱楚涵')
)
SELECT 'm113_action' AS row_type, 'employees.company_id' AS target,
       e.id::text AS entity_id, e.name AS employee_name,
       e.company_id AS before_value, '38' AS after_value
  FROM employees e
  JOIN target t ON t.name = e.name
 WHERE e.company_id = '37'
 ORDER BY e.name;

WITH target(name) AS (
  VALUES ('李美倩'), ('林彩云'), ('林志凌'), ('邱楚涵')
)
SELECT 'm113_action' AS row_type, 'hr_employee_events.insert' AS target,
       e.id::text AS entity_id, e.name AS employee_name,
       'BABI' AS before_value, 'OCEANBABY' AS after_value
  FROM hr_employees e
  JOIN target t ON t.name = e.name
 WHERE e.company_code = 'BABI'
   AND NOT EXISTS (
       SELECT 1 FROM hr_employee_events ev
        WHERE ev.employee_id = e.id
          AND ev.event_type = 'transfer'
          AND ev.event_date = DATE '2026-08-01'
          AND ev.from_value = 'BABI'
          AND ev.to_value = 'OCEANBABY'
   )
 ORDER BY e.name;

SELECT 'M113_snapshot_guard' AS phase, 'hr_payroll' AS target,
       COUNT(*) AS rows_before,
       COALESCE(SUM(net_amount), 0) AS net_sum_before
  FROM hr_payroll
 WHERE company_code = 'BABI'
   AND employee_name IN ('李美倩','林彩云','林志凌','邱楚涵');

SELECT 'M113_snapshot_guard' AS phase, 'payroll_sheets' AS target,
       COUNT(*) AS rows_before,
       COALESCE(SUM(ps.net_pay), 0) AS net_sum_before
  FROM payroll_sheets ps
 WHERE EXISTS (
       SELECT 1 FROM employees e
        WHERE e.id = ps.employee_id
          AND e.name IN ('李美倩','林彩云','林志凌','邱楚涵')
 );

DO $$
DECLARE
  live boolean := COALESCE(current_setting('app.m113_live', true), '0') = '1';
  moved_hr integer := 0;
  moved_legacy integer := 0;
  inserted_events integer := 0;
  payroll_rows_before integer := 0;
  payroll_net_before numeric := 0;
  payroll_rows_after integer := 0;
  payroll_net_after numeric := 0;
  sheets_rows_before integer := 0;
  sheets_net_before numeric := 0;
  sheets_rows_after integer := 0;
  sheets_net_after numeric := 0;
BEGIN
  IF NOT live THEN
    RAISE NOTICE 'M113 dry-run only: set app.m113_live=1 to apply';
    RETURN;
  END IF;

  SELECT COUNT(*), COALESCE(SUM(net_amount), 0)
    INTO payroll_rows_before, payroll_net_before
    FROM hr_payroll
   WHERE company_code = 'BABI'
     AND employee_name IN ('李美倩','林彩云','林志凌','邱楚涵');

  SELECT COUNT(*), COALESCE(SUM(ps.net_pay), 0)
    INTO sheets_rows_before, sheets_net_before
    FROM payroll_sheets ps
   WHERE EXISTS (
         SELECT 1 FROM employees e
          WHERE e.id = ps.employee_id
            AND e.name IN ('李美倩','林彩云','林志凌','邱楚涵')
   );

  UPDATE hr_employees
     SET company_code = 'OCEANBABY'
   WHERE company_code = 'BABI'
     AND name IN ('李美倩','林彩云','林志凌','邱楚涵');
  GET DIAGNOSTICS moved_hr = ROW_COUNT;

  UPDATE employees
     SET company_id = '38',
         updated_at = now()
   WHERE company_id = '37'
     AND name IN ('李美倩','林彩云','林志凌','邱楚涵');
  GET DIAGNOSTICS moved_legacy = ROW_COUNT;

  INSERT INTO hr_employee_events
    (company_code, employee_id, employee_name, event_type, event_date,
     from_value, to_value, checklist, note, operator, created_at)
  SELECT 'OCEANBABY', e.id, e.name, 'transfer', DATE '2026-08-01',
         'BABI', 'OCEANBABY', NULL,
         'M113: Damon 2026-09-09 定，4人主体转移；历史 hr_payroll/payroll_sheets 快照不动',
         'migration:M113', now()
    FROM hr_employees e
   WHERE e.company_code = 'OCEANBABY'
     AND e.name IN ('李美倩','林彩云','林志凌','邱楚涵')
     AND NOT EXISTS (
         SELECT 1 FROM hr_employee_events ev
          WHERE ev.employee_id = e.id
            AND ev.event_type = 'transfer'
            AND ev.event_date = DATE '2026-08-01'
            AND ev.from_value = 'BABI'
            AND ev.to_value = 'OCEANBABY'
     );
  GET DIAGNOSTICS inserted_events = ROW_COUNT;

  RAISE NOTICE 'M113 live applied: hr_employees %, employees %, hr_employee_events %',
               moved_hr, moved_legacy, inserted_events;

  SELECT COUNT(*), COALESCE(SUM(net_amount), 0)
    INTO payroll_rows_after, payroll_net_after
    FROM hr_payroll
   WHERE company_code = 'BABI'
     AND employee_name IN ('李美倩','林彩云','林志凌','邱楚涵');

  SELECT COUNT(*), COALESCE(SUM(ps.net_pay), 0)
    INTO sheets_rows_after, sheets_net_after
    FROM payroll_sheets ps
   WHERE EXISTS (
         SELECT 1 FROM employees e
          WHERE e.id = ps.employee_id
            AND e.name IN ('李美倩','林彩云','林志凌','邱楚涵')
   );

  IF payroll_rows_after <> payroll_rows_before
     OR payroll_net_after IS DISTINCT FROM payroll_net_before THEN
    RAISE EXCEPTION 'M113 guard failed: hr_payroll snapshot changed, rows % -> %, net % -> %',
      payroll_rows_before, payroll_rows_after, payroll_net_before, payroll_net_after;
  END IF;

  IF sheets_rows_after <> sheets_rows_before
     OR sheets_net_after IS DISTINCT FROM sheets_net_before THEN
    RAISE EXCEPTION 'M113 guard failed: payroll_sheets snapshot changed, rows % -> %, net % -> %',
      sheets_rows_before, sheets_rows_after, sheets_net_before, sheets_net_after;
  END IF;
END $$;

SELECT 'M113_after_hr_employees' AS phase, id, name, company_code
  FROM hr_employees
 WHERE name IN ('李美倩','林彩云','林志凌','邱楚涵')
 ORDER BY name;

SELECT 'M113_after_employees' AS phase, id, name, company_id
  FROM employees
 WHERE name IN ('李美倩','林彩云','林志凌','邱楚涵')
 ORDER BY name;
