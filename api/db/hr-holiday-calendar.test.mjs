#!/usr/bin/env node
import assert from "node:assert/strict";
import { buildHolidayCalendar, compactDateRanges, holidayNoticeTitle } from "./hr-holiday-calendar.mjs";

const CO = "JINFANG";
const employees = [
  { id: 1, name: "汪卫云", company_code: CO },
  { id: 2, name: "周三休", company_code: CO },
  { id: 3, name: "上五休二", company_code: CO },
  { id: 4, name: "法定上班", company_code: CO },
  { id: 5, name: "兼职", company_code: CO, employment_type: "parttime" },
];
const restRules = [
  { company_code: CO, employee_id: null, weekday: 1, effective_from: "2026-09-01", effective_to: null },
  { company_code: CO, employee_id: 2, weekday: 3, effective_from: "2026-09-01", effective_to: null },
  { company_code: CO, employee_id: 3, weekday: 0, effective_from: "2026-09-01", effective_to: null },
  { company_code: CO, employee_id: 3, weekday: 6, effective_from: "2026-09-01", effective_to: null },
];
const holidays = [
  ...["2026-10-01", "2026-10-02", "2026-10-03"].map((d) => ({ holiday_date: d, kind: "legal", name: "国庆" })),
  { holiday_date: "2026-09-20", kind: "makeup_work", name: "国庆调休" },
  { holiday_date: "2026-10-10", kind: "makeup_work", name: "国庆调休" },
];
const storePlans = [{ id: 9, company_code: CO, name: "国庆", start_date: "2026-10-01", end_date: "2026-10-05" }];

function byDate(emp, d) {
  return emp.days.find((x) => x.date === d);
}

function paidCounts(emp) {
  return {
    holiday_paid_days: emp.days.filter((d) => d.type === "legal_off").length,
    store_paid_days: emp.days.filter((d) => d.type === "store_off").length,
  };
}

const out = buildHolidayCalendar({
  employees, restRules, holidays, storePlans,
  restChanges: [{ employee_id: 1, orig_date: "2026-09-21", new_date: "2026-09-22", status: "approved" }],
  shifts: [{ employee_id: 4, work_date: "2026-10-01", is_rest_day: false }],
  from: "2026-09-14", to: "2026-10-12", companyCode: CO,
});
const wang = out.find((x) => x.employee_id === 1);
assert.equal(byDate(wang, "2026-10-01").type, "legal_off");
assert.equal(byDate(wang, "2026-10-02").type, "legal_off");
assert.equal(byDate(wang, "2026-10-03").type, "legal_off");
assert.equal(byDate(wang, "2026-10-04").type, "store_off");
assert.equal(byDate(wang, "2026-10-05").type, "weekly_rest");
assert.equal(byDate(wang, "2026-10-06").type, "work");
assert.equal(byDate(wang, "2026-09-20").type, "work");
assert.equal(byDate(wang, "2026-10-10").type, "work");
assert.deepEqual(paidCounts(wang), { holiday_paid_days: 3, store_paid_days: 1 });

const wed = out.find((x) => x.employee_id === 2);
assert.equal(byDate(wed, "2026-09-16").type, "weekly_rest");
assert.equal(byDate(wed, "2026-09-14").type, "work");
assert.equal(byDate(wed, "2026-09-16").rest_rule_source, "employee");

assert.equal(byDate(wang, "2026-09-21").type, "work");
assert.equal(byDate(wang, "2026-09-22").type, "weekly_rest");

const five = out.find((x) => x.employee_id === 3);
assert.equal(byDate(five, "2026-09-20").type, "makeup_work");

const legalWork = out.find((x) => x.employee_id === 4);
assert.equal(byDate(legalWork, "2026-10-01").type, "legal_work");
assert.equal(byDate(legalWork, "2026-10-01").holiday_multiplier, 3);

const parttime = out.find((x) => x.employee_id === 5);
assert.equal(byDate(parttime, "2026-10-01").type, "parttime_off");
assert.equal(byDate(parttime, "2026-10-04").type, "parttime_off");
assert.equal(parttime.summary.text, "兼职,按排班");

assert.equal(byDate(wang, "2026-10-05").overlaps_weekly_rest, false);
const legalMonday = buildHolidayCalendar({
  employees: [{ id: 1, name: "汪卫云", company_code: CO }],
  restRules, holidays: [{ holiday_date: "2026-10-05", kind: "legal", name: "测试" }],
  from: "2026-10-05", to: "2026-10-05", companyCode: CO,
});
assert.equal(legalMonday[0].days[0].overlaps_weekly_rest, true);
assert.equal(legalMonday[0].days[0].type, "legal_off");

assert.equal(compactDateRanges(["2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28"]), "9月25日至28日");
assert.equal(compactDateRanges(["2026-09-30", "2026-10-01", "2026-10-02"]), "9月30日至10月2日");
assert.equal(compactDateRanges(["2026-10-02"]), "10月2日");

const noticeRows = buildHolidayCalendar({
  employees: [
    { id: 1, name: "汪卫云", company_code: CO, employment_type: "fulltime" },
    { id: 2, name: "周三休", company_code: CO, employment_type: "fulltime" },
  ],
  restRules,
  holidays,
  storePlans: [{ id: 10, company_code: CO, name: "国庆", start_date: "2026-10-01", end_date: "2026-10-04" }],
  from: "2026-10-01", to: "2026-10-06", companyCode: CO,
});
const t1 = holidayNoticeTitle({ name: "国庆", start_date: "2026-10-01", end_date: "2026-10-04" }, noticeRows[0]);
const t2 = holidayNoticeTitle({ name: "国庆", start_date: "2026-10-01", end_date: "2026-10-04" }, noticeRows[1]);
assert.notEqual(t1, t2);

console.log("hr-holiday-calendar tests passed");
