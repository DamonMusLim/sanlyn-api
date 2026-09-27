const DAY = 86400000;

export const WEEKDAY_LABEL = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function dateRange(from, to) {
  const out = [];
  for (let t = Date.parse(from + "T00:00:00Z"), e = Date.parse(to + "T00:00:00Z"); t <= e; t += DAY) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

function weekday(d) {
  return new Date(d + "T00:00:00Z").getUTCDay();
}

function inRange(d, row) {
  return row.effective_from <= d && (!row.effective_to || row.effective_to >= d);
}

function applies(row, empId) {
  return row.employee_id == null || String(row.employee_id) === String(empId);
}

export function activeRestRule(restRules, companyCode, empId, d) {
  const rows = (restRules || [])
    .filter((r) => (!companyCode || r.company_code === companyCode) && applies(r, empId) && inRange(d, r));
  const personal = rows.filter((r) => r.employee_id != null);
  const picked = personal.length ? personal : rows.filter((r) => r.employee_id == null);
  const latest = picked.reduce((m, r) => r.effective_from > m ? r.effective_from : m, "");
  const active = picked.filter((r) => r.effective_from === latest);
  return {
    weekdays: [...new Set(active.map((r) => Number(r.weekday)))].sort((a, b) => a - b),
    source: personal.length ? "employee" : (active.length ? "store" : null),
  };
}

function indexBy(rows, key) {
  const m = new Map();
  for (const r of rows || []) m.set(key(r), r);
  return m;
}

function changesFor(changes, empId) {
  const orig = new Set(), next = new Set();
  for (const r of changes || []) {
    if (String(r.employee_id) !== String(empId) || r.status !== "approved") continue;
    orig.add(r.orig_date);
    next.add(r.new_date);
  }
  return { orig, next };
}

function planOn(plans, companyCode, d) {
  return (plans || []).find((p) => (!companyCode || p.company_code === companyCode) && p.start_date <= d && p.end_date >= d) || null;
}

function nextWork(days, after) {
  return days.find((d) => d.date > after && (d.type === "work" || d.type === "makeup_work" || d.type === "legal_work"))?.date || null;
}

function summarize(days) {
  const offTypes = new Set(["weekly_rest", "legal_off", "store_off"]);
  const off = days.filter((d) => offTypes.has(d.type));
  const makeup = days.filter((d) => d.type === "makeup_work").map((d) => d.date);
  const lastOff = off.reduce((m, d) => d.date > m ? d.date : m, "");
  return {
    off_days: off.length,
    off_dates: off.map((d) => d.date),
    return_to_work: lastOff ? nextWork(days, lastOff) : null,
    makeup_work_dates: makeup,
    makeup_text: makeup.length ? makeup.join(",") : "不用补班",
    legal_work_days: days.filter((d) => d.type === "legal_work").length,
  };
}

export function buildHolidayCalendar(input) {
  const employees = input.employees || [];
  const holidays = indexBy(input.holidays, (r) => r.holiday_date);
  const shifts = indexBy(input.shifts, (r) => `${r.employee_id}:${r.work_date}`);
  const dates = dateRange(input.from, input.to);

  return employees.map((emp) => {
    const changed = changesFor(input.restChanges, emp.id);
    const days = dates.map((d) => {
      const rule = activeRestRule(input.restRules, emp.company_code || input.companyCode, emp.id, d);
      const weekly = rule.weekdays.includes(weekday(d));
      const fiveDay = rule.weekdays.length >= 2;
      const shift = shifts.get(`${emp.id}:${d}`) || null;
      const hol = holidays.get(d) || null;
      const storePlan = planOn(input.storePlans, emp.company_code || input.companyCode, d);
      let isRest = changed.next.has(d) || (weekly && !changed.orig.has(d));
      let type = isRest ? "weekly_rest" : "work";
      if (hol?.kind === "makeup_work" && fiveDay) {
        isRest = false; type = "makeup_work";
      }
      if (storePlan && !hol && !isRest) {
        isRest = true; type = "store_off";
      }
      if (shift) {
        isRest = !!shift.is_rest_day;
        type = isRest ? (weekly ? "weekly_rest" : "store_off") : "work";
      }
      if (hol?.kind === "legal") {
        isRest = shift ? isRest : true;
        type = isRest ? "legal_off" : "legal_work";
      }
      return {
        date: d, type, is_rest_day: isRest,
        holiday_name: hol?.name || null,
        plan_id: storePlan?.id || null,
        rest_rule_source: rule.source,
        rest_weekdays: rule.weekdays,
        overlaps_weekly_rest: !!(hol?.kind === "legal" && weekly),
        holiday_multiplier: type === "legal_work" ? 3 : null,
      };
    });
    return { employee_id: emp.id, employee_name: emp.name, days, summary: summarize(days) };
  });
}

export function compactDateRanges(dates) {
  const xs = [...dates].sort();
  if (!xs.length) return "";
  const ranges = [];
  let start = xs[0], prev = xs[0];
  for (const d of xs.slice(1)) {
    const next = new Date(Date.parse(prev + "T00:00:00Z") + DAY).toISOString().slice(0, 10);
    if (d === next) prev = d;
    else { ranges.push([start, prev]); start = prev = d; }
  }
  ranges.push([start, prev]);
  return ranges.map(([a, b]) => a === b ? fmtMd(a) : `${fmtMd(a)}-${fmtMd(b).slice(3)}`).join(",");
}

export function fmtMd(d) {
  return `${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日`;
}
