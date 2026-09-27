# Holiday Calendar Report

## Scope
- Backend worktree: `/home/damon/wt-holiday`
- Staff worktree: `/home/damon/wt-holiday/_staff`
- No production DB writes, no migration run, no deploy, no push.

## Checks
```bash
node --check api/db/hr-holiday-calendar.mjs
node --check api/db/hr-holiday-calendar.test.mjs
node --check api/db/hr-holiday.mjs
node --check api/db/hr-payroll.mjs
node --check api/db/hr-payroll.test.mjs
node --check _staff/staff-manager.js
```
Output: no output, exit 0.

```bash
node api/db/hr-holiday-calendar.test.mjs
```
Output:
```text
hr-holiday-calendar tests passed
```

```bash
node api/db/hr-payroll.test.mjs
```
Output:
```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'pg' imported from /home/damon/wt-holiday/api/db/db.js
```
Result: not run in this checkout because local node dependencies are missing.

```bash
psql --version
```
Output:
```text
/bin/bash: line 1: psql: command not found
```
Result: migration not executed locally. M124 was manually checked for `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `ON CONFLICT DO NOTHING`, and guarded seed insert.

## Coverage Notes
- Covered by `hr-holiday-calendar.test.mjs`: six-day Monday rest employee, employee-level rest override, approved rest change, five-day makeup work, legal scheduled work multiplier flag, legal day overlapping weekly rest.
- Payroll test was updated for monthly employee scheduled on 2026-10-01, expecting `holiday_amount = daily_rate * 3`, but needs `pg` and migrated DB schema to execute.
- `hr_day_agenda` now has `employee_id/employee_name` columns in M124 for per-employee notices. Existing portal filtering was not changed in this scope.

## Diff Stat
Backend:
```text
api/db/hr-payroll.mjs                      | 34 +++++++++++++++++++++++-----------
api/db/hr-payroll.test.mjs                 | 27 ++++++++++++++++-----------
api/db/hr-holiday-calendar.mjs             | 138 +++++++++++++++++++++++++++++++++
api/db/hr-holiday-calendar.test.mjs        | 69 +++++++++++++++++
api/db/hr-holiday.mjs                      | 178 +++++++++++++++++++++++++++++++++++++++++++
migrations/M124-20260927-holiday-calendar.sql | 79 +++++++++++++++++++
REPORT.md                                  | 48 ++++++++++++
```

Staff:
```text
staff-manager.js | 55 +++++++++++++++++++++++++++++++++++++++++++++++++++++++
```
