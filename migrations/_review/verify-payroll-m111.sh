#!/usr/bin/env bash
set -u

fail=0

PSQL_BIN="${PSQL_BIN:-psql}"
DB_URL="${DATABASE_URL:-}"

if [[ -n "$DB_URL" ]]; then
  PSQL=("$PSQL_BIN" "$DB_URL" -X -v ON_ERROR_STOP=1 -Atq)
else
  PSQL=("$PSQL_BIN" -X -v ON_ERROR_STOP=1 -Atq)
fi

run_sql() {
  "${PSQL[@]}" -c "$1"
}

check_eq() {
  local name="$1"
  local sql="$2"
  local want="$3"
  local got
  if ! got="$(run_sql "$sql")"; then
    echo "FAIL $name: query_error"
    fail=1
    return
  fi
  got="$(echo "$got" | tr -d '[:space:]')"
  if [[ "$got" == "$want" ]]; then
    echo "PASS $name: $got"
  else
    echo "FAIL $name: got=$got want=$want"
    fail=1
  fi
}

check_eq "1_net_sum_202606" \
  "SELECT COALESCE(TO_CHAR(SUM(net_amount), 'FM9999999990.00'), '') FROM hr_payroll WHERE company_code='BABI' AND period='2026-06';" \
  "48869.63"

check_eq "2_lincaiyun_gross_202606" \
  "SELECT COALESCE(TO_CHAR(gross_amount, 'FM9999999990.00'), '') FROM hr_payroll WHERE company_code='BABI' AND period='2026-06' AND employee_name='林彩云';" \
  "5400.00"

check_eq "3_net_null_count_202606" \
  "SELECT COUNT(*)::text FROM hr_payroll WHERE company_code='BABI' AND period='2026-06' AND net_amount IS NULL;" \
  "0"

check_eq "4_tax_null_count_202606" \
  "SELECT COUNT(*)::text FROM hr_payroll WHERE company_code='BABI' AND period='2026-06' AND tax_amount IS NULL;" \
  "3"

check_eq "5_diff_records_sum" \
  "SELECT COALESCE(TO_CHAR(SUM(amount), 'FM9999999990.00'), '') FROM finance_records WHERE created_by='payroll-m111' AND record_no IN ('PAY-M111-202606-LINCY-OVERPAID','PAY-M111-202606-WITHHELD-ADVANCE');" \
  "4541.67"

check_eq "5_diff_formula" \
  "SELECT TO_CHAR(53411.30::numeric - SUM(net_amount), 'FM9999999990.00') FROM hr_payroll WHERE company_code='BABI' AND period='2026-06';" \
  "4541.67"

check_eq "6_distinct_periods" \
  "SELECT COUNT(DISTINCT period)::text FROM hr_payroll WHERE company_code='BABI' AND period BETWEEN '2025-11' AND '2026-06';" \
  "8"

check_eq "7_unsplit_person_rows" \
  "SELECT COUNT(*)::text FROM hr_payroll WHERE company_code='BABI' AND period IN ('2025-11','2025-12','2026-01','2026-02') AND employee_id IS NOT NULL;" \
  "0"

m113_actions="$(
  "${PSQL[@]}" -f migrations/M113-20260909-employee-entity-transfer.sql 2>/tmp/verify-payroll-m111-m113.err \
    | awk -F '|' '$1=="m113_action"{c++} END{print c+0}'
)"
if [[ "$m113_actions" == "11" ]]; then
  echo "PASS 8_m113_dry_run_actions: $m113_actions"
else
  echo "FAIL 8_m113_dry_run_actions: got=$m113_actions want=11"
  cat /tmp/verify-payroll-m111-m113.err
  fail=1
fi

check_eq "8_m113_payroll_guard" \
  "SELECT COUNT(*)::text FROM hr_payroll WHERE company_code='BABI' AND period >= '2026-08' AND employee_name IN ('李美倩','林彩云','林志凌','邱楚涵');" \
  "0"

check_eq "8_m113_payroll_sheets_guard" \
  "SELECT COUNT(*)::text FROM payroll_sheets WHERE company_id IN ('37','co-babi') AND period_id >= '2026-08';" \
  "0"

si_cols="$(run_sql "SELECT STRING_AGG(quote_ident(column_name), ',') FROM information_schema.columns WHERE table_name='hr_payroll' AND column_name LIKE 'si\_%\_co' ESCAPE '\' ;")"
if [[ -z "${si_cols// }" ]]; then
  echo "PASS 9_si_co_columns_absent"
else
  si_expr="$(run_sql "SELECT STRING_AGG('COALESCE(' || quote_ident(column_name) || ',0) <> 0', ' OR ') FROM information_schema.columns WHERE table_name='hr_payroll' AND column_name LIKE 'si\_%\_co' ESCAPE '\' ;")"
  si_bad="$(run_sql "SELECT COUNT(*)::text FROM hr_payroll WHERE company_code='BABI' AND period BETWEEN '2025-11' AND '2026-06' AND ($si_expr);")"
  if [[ "$si_bad" == "0" ]]; then
    echo "PASS 9_si_co_unchanged_zero_or_null"
  else
    echo "FAIL 9_si_co_unchanged_zero_or_null: got=$si_bad want=0"
    fail=1
  fi
fi

exit "$fail"
