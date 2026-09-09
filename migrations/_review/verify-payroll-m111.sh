#!/usr/bin/env bash
set -u

fail=0

M111="migrations/M111-20260909-payroll-202606-net.sql"
M112="migrations/M112-20260909-payroll-backfill-7periods.sql"
M113="migrations/M113-20260909-employee-entity-transfer.sql"
VERIFY="migrations/_review/verify-payroll-m111.sh"
FILES=("$M111" "$M112" "$M113" "$VERIFY")

report() {
  local name="$1"
  local criterion="$2"
  local actual="$3"
  local ok="$4"
  if [[ "$ok" == "1" ]]; then
    echo "$name | $criterion -> $actual -> PASS"
  else
    echo "$name | $criterion -> $actual -> FAIL"
    fail=1
  fi
}

set_list() {
  awk '/^UPDATE hr_payroll p/{in_set=1} in_set{print} /^  FROM target t/{exit}' "$M111"
}

m112_values() {
  awk '/^WITH target\(period, bank_amount, paid_at, note\) AS/{in_values=1; next} in_values && /^INSERT INTO hr_payroll/{exit} in_values{print}' "$M112"
}

line_no() {
  local pattern="$1"
  local file="$2"
  grep -n "$pattern" "$file" | head -1 | cut -d: -f1
}

direction_ar_count="$(grep -c "'AR'" "$M111" || true)"
direction_in_count="$(grep -c "PAY-M111-202606-.*'in'" "$M111" || true)"
if [[ "$direction_ar_count" == "0" && "$direction_in_count" == "2" ]]; then
  report "1_m111_direction" "全部为'in'且文件不出现'AR'" "in_rows=$direction_in_count AR=$direction_ar_count" 1
else
  report "1_m111_direction" "全部为'in'且文件不出现'AR'" "in_rows=$direction_in_count AR=$direction_ar_count" 0
fi

base_set_count="$(set_list | grep -c "base_amount" || true)"
report "2_m111_update_set" "UPDATE SET列表不含base_amount" "base_amount_occurrences=$base_set_count" "$([[ "$base_set_count" == "0" ]] && echo 1 || echo 0)"

expected_mapping=$'2025-11=58612.80\n2026-01=51978.98\n2026-02=56629.69\n2026-03=53411.30\n2026-04=53411.30\n2026-05=53411.30'
actual_mapping="$(
  m112_values |
    sed -n "s/^[[:space:]]*('\([0-9-]*\)', \([0-9.]*\)::numeric,.*/\1=\2/p"
)"
report "3_m112_mapping" "期间金额映射等于6行目标表" "$actual_mapping" "$([[ "$actual_mapping" == "$expected_mapping" ]] && echo 1 || echo 0)"

m112_row_count="$(m112_values | grep -c "^[[:space:]]*('[0-9][0-9][0-9][0-9]-[0-9][0-9]'" || true)"
m112_202606_count="$(m112_values | grep -c "'2026-06'" || true)"
if [[ "$m112_row_count" == "6" && "$m112_202606_count" == "0" ]]; then
  report "4_m112_row_count" "建6行且不含period='2026-06'" "rows=$m112_row_count period_2026_06=$m112_202606_count" 1
else
  report "4_m112_row_count" "建6行且不含period='2026-06'" "rows=$m112_row_count period_2026_06=$m112_202606_count" 0
fi

gross_status_count="$(grep -c "NULL, bank_amount, NULL, 'imported'" "$M112" || true)"
report "5_m112_batch_fields" "gross_amount为NULL且status='imported'" "matching_select_rows=$gross_status_count" "$([[ "$gross_status_count" == "1" ]] && echo 1 || echo 0)"

bad_period_amounts="$(m112_values | grep -E "^[[:space:]]*\\('[0-9-]+', (29306\\.40|36478\\.98|40978\\.98|37629\\.69)::numeric" || true)"
report "6_m112_bad_period_amounts" "29306.40/36478.98/40978.98/37629.69均不作为期间金额" "${bad_period_amounts:-none}" "$([[ -z "$bad_period_amounts" ]] && echo 1 || echo 0)"

dry_run_line="$(line_no "THEN 'LIVE' ELSE 'DRY_RUN'" "$M113")"
return_line="$(line_no "RETURN;" "$M113")"
first_update_line="$(line_no "^  UPDATE " "$M113")"
if [[ -n "$dry_run_line" && -n "$return_line" && -n "$first_update_line" && "$return_line" -lt "$first_update_line" ]]; then
  report "7_m113_default_dry_run" "默认输出DRY_RUN且DO块先RETURN" "dry_run_line=$dry_run_line return_line=$return_line first_update_line=$first_update_line" 1
else
  report "7_m113_default_dry_run" "默认输出DRY_RUN且DO块先RETURN" "dry_run_line=${dry_run_line:-missing} return_line=${return_line:-missing} first_update_line=${first_update_line:-missing}" 0
fi

period_guard_hits="$(grep -E "period >= '2026-08'|period_id >= '2026-08'" "$M113" || true)"
snapshot_terms="$(grep -E "COUNT\\(\\*\\).*rows_before|SUM\\(net_amount\\)|SUM\\(net_pay\\)|snapshot changed" "$M113" | wc -l | tr -d '[:space:]')"
if [[ -z "$period_guard_hits" && "$snapshot_terms" -ge 4 ]]; then
  report "8_m113_snapshot_guard" "hr_payroll/payroll_sheets查全表且无2026-08期间限制" "period_filters=0 snapshot_terms=$snapshot_terms" 1
else
  report "8_m113_snapshot_guard" "hr_payroll/payroll_sheets查全表且无2026-08期间限制" "period_filters=${period_guard_hits:-0} snapshot_terms=$snapshot_terms" 0
fi

bad_pattern="$(printf '%s|%s|%s|%s' TO''DO FIX''ME PLACE''HOLDER 占''位''符)"
placeholder_hits="$(grep -En "$bad_pattern" "${FILES[@]}" || true)"
bash_n_result="PASS"
if ! bash -n "$VERIFY"; then
  bash_n_result="FAIL"
fi
if [[ -z "$placeholder_hits" && "$bash_n_result" == "PASS" ]]; then
  report "9_static_hygiene" "四文件无待办/占位文本且bash -n验收脚本PASS" "placeholders=0 bash_n=$bash_n_result" 1
else
  report "9_static_hygiene" "四文件无待办/占位文本且bash -n验收脚本PASS" "placeholders=${placeholder_hits:-0} bash_n=$bash_n_result" 0
fi

exit "$fail"
