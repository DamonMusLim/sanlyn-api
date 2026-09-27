// /api/db/hr-holiday.mjs — 法定假日 + 店内放假计划
import { getPool, setCors } from "./db.js";
import { requireAuth } from "./auth.js";
import { buildHolidayCalendar, compactDateRanges, fmtMd } from "./hr-holiday-calendar.mjs";

const D = "YYYY-MM-DD";
const MANAGER_ROLES = new Set(["boss", "manager", "store_manager", "admin"]);

function monthRange(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ""))) throw new Error("month 必须是 YYYY-MM");
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(8, 10);
  return { from: `${month}-01`, to: `${month}-${last}` };
}

function todayCN() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

function prevDay(d) {
  return new Date(Date.parse(d + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
}

function noticeText(plan, result) {
  const off = compactDateRanges(result.summary.off_dates);
  const back = result.summary.return_to_work ? fmtMd(result.summary.return_to_work) : "待排班确认";
  return `${plan.name}放假：${off}，${back}上班`;
}

function planSummary(result, plan) {
  const offTypes = new Set(["weekly_rest", "legal_off", "store_off"]);
  const inPlan = result.days.filter((d) => d.date >= plan.start_date && d.date <= plan.end_date);
  const off = inPlan.filter((d) => offTypes.has(d.type));
  const back = result.days.find((d) => d.date > plan.end_date &&
    ["work", "makeup_work", "legal_work"].includes(d.type));
  const makeup = result.days.filter((d) => d.date > plan.end_date && d.type === "makeup_work").map((d) => d.date);
  return {
    ...result,
    summary: {
      off_days: off.length,
      off_dates: off.map((d) => d.date),
      return_to_work: back?.date || null,
      makeup_work_dates: makeup,
      makeup_text: makeup.length ? makeup.join(",") : "不用补班",
      legal_work_days: inPlan.filter((d) => d.type === "legal_work").length,
    },
  };
}

async function actor(pool, req, company) {
  const u = req.user || {};
  if (u.employee_id) {
    const r = await pool.query(
      `SELECT id,name,role,company_code FROM hr_employees WHERE id=$1`, [u.employee_id]);
    const me = r.rows[0] || null;
    return { employeeId: u.employee_id, manager: me && MANAGER_ROLES.has(String(me.role || "")), me };
  }
  return { employeeId: null, manager: MANAGER_ROLES.has(String(u.role || "")), me: { company_code: company } };
}

async function loadInputs(pool, company, from, to, employeeId) {
  const empParams = [company];
  let empSql = `SELECT id,name,company_code FROM hr_employees
                 WHERE company_code=$1 AND employment_status='active'`;
  if (employeeId) { empParams.push(employeeId); empSql += ` AND id=$${empParams.length}`; }
  empSql += " ORDER BY name";
  const [employees, restRules, restChanges, holidays, plans, shifts] = await Promise.all([
    pool.query(empSql, empParams),
    pool.query(`SELECT company_code, employee_id, weekday,
                       to_char(effective_from,'${D}') AS effective_from,
                       to_char(effective_to,'${D}') AS effective_to
                  FROM hr_rest_rules
                 WHERE company_code=$1 AND effective_from <= $2
                   AND (effective_to IS NULL OR effective_to >= $3)`, [company, to, from]),
    pool.query(`SELECT employee_id, to_char(orig_date,'${D}') AS orig_date,
                       to_char(new_date,'${D}') AS new_date, status
                  FROM hr_rest_change_requests
                 WHERE company_code=$1 AND status='approved'
                   AND (orig_date BETWEEN $2 AND $3 OR new_date BETWEEN $2 AND $3)`, [company, from, to]),
    pool.query(`SELECT to_char(holiday_date,'${D}') AS holiday_date, kind, name, note
                  FROM hr_public_holidays WHERE holiday_date BETWEEN $1 AND $2`, [from, to]),
    pool.query(`SELECT id, company_code, name, to_char(start_date,'${D}') AS start_date,
                       to_char(end_date,'${D}') AS end_date, note
                  FROM hr_store_holiday_plans
                 WHERE company_code=$1 AND start_date <= $2 AND end_date >= $3
                 ORDER BY start_date`, [company, to, from]),
    pool.query(`SELECT employee_id, to_char(work_date,'${D}') AS work_date, is_rest_day
                  FROM hr_shifts WHERE company_code=$1 AND work_date BETWEEN $2 AND $3`, [company, from, to]),
  ]);
  return {
    employees: employees.rows, restRules: restRules.rows, restChanges: restChanges.rows,
    holidays: holidays.rows, storePlans: plans.rows, shifts: shifts.rows,
    from, to, companyCode: company,
  };
}

async function calendar(pool, company, from, to, employeeId) {
  return buildHolidayCalendar(await loadInputs(pool, company, from, to, employeeId));
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  const requestedCompany = req.query?.company_code || req.body?.company_code || "JINFANG";
  try {
    const who = await actor(pool, req, requestedCompany);
    const company = who.employeeId && who.me?.company_code ? who.me.company_code : requestedCompany;
    const ownOnly = !who.manager;
    if (ownOnly && !who.employeeId) return res.status(403).json({ success: false, error: "无员工身份" });

    if (req.method === "GET" && req.query?.action === "plans") {
      if (!who.manager) return res.status(403).json({ success: false, error: "无权限" });
      const r = await pool.query(
        `SELECT id, name, to_char(start_date,'${D}') AS start_date, to_char(end_date,'${D}') AS end_date, note
           FROM hr_store_holiday_plans WHERE company_code=$1 ORDER BY start_date DESC LIMIT 30`, [company]);
      return res.status(200).json({ success: true, data: r.rows });
    }

    if (req.method === "GET" && req.query?.action === "calendar") {
      const { from, to } = monthRange(req.query.month);
      const eid = ownOnly ? who.employeeId : (req.query.employee_id || null);
      const data = await calendar(pool, company, from, to, eid);
      return res.status(200).json({ success: true, data, from, to });
    }

    if (req.method === "GET" && req.query?.action === "plan") {
      const plan = (await pool.query(
        `SELECT id, company_code, name, to_char(start_date,'${D}') AS start_date,
                to_char(end_date,'${D}') AS end_date, note
           FROM hr_store_holiday_plans WHERE id=$1 AND company_code=$2`, [req.query.plan_id, company])).rows[0];
      if (!plan) return res.status(404).json({ success: false, error: "计划不存在" });
      const from = plan.start_date.slice(0, 8) + "01";
      const to = new Date(Date.UTC(Number(plan.end_date.slice(0, 4)), Number(plan.end_date.slice(5, 7)), 0))
        .toISOString().slice(0, 10);
      const data = (await calendar(pool, company, from, to, ownOnly ? who.employeeId : null))
        .map((r) => planSummary(r, plan));
      return res.status(200).json({ success: true, plan, data });
    }

    if (req.method === "POST" && req.body?.action === "publish_notice") {
      if (!who.manager) return res.status(403).json({ success: false, error: "只有老板/经理能推公告" });
      const plan = (await pool.query(
        `SELECT id, company_code, name, to_char(start_date,'${D}') AS start_date,
                to_char(end_date,'${D}') AS end_date, note
           FROM hr_store_holiday_plans WHERE id=$1 AND company_code=$2`, [req.body.plan_id, company])).rows[0];
      if (!plan) return res.status(404).json({ success: false, error: "计划不存在" });
      const rangeTo = new Date(Date.UTC(Number(plan.end_date.slice(0, 4)), Number(plan.end_date.slice(5, 7)), 0))
        .toISOString().slice(0, 10);
      const data = (await calendar(pool, company, plan.start_date, rangeTo, null))
        .map((r) => planSummary(r, plan));
      const from = todayCN(), noticeTo = prevDay(plan.start_date);
      const rows = [];
      for (const r of data) {
        const title = noticeText(plan, r);
        if (from <= noticeTo) rows.push({ employee_id: r.employee_id, employee_name: r.employee_name, from, to: noticeTo, title, note: title });
      }
      if (req.body.dry_run) return res.status(200).json({ success: true, dry_run: true, data: rows });
      let inserted = 0;
      for (const x of rows) {
        const q = await pool.query(
          `INSERT INTO hr_day_agenda
             (company_code, employee_id, employee_name, work_date, kind, title, note, status)
           SELECT $1,$2,$3,dd::date,'notice',$4,$5,'open'
             FROM generate_series($6::date,$7::date,INTERVAL '1 day') AS dd
           ON CONFLICT DO NOTHING`,
          [company, x.employee_id, x.employee_name, x.title, x.note, x.from, x.to]);
        inserted += q.rowCount || 0;
      }
      return res.status(200).json({ success: true, inserted, data: rows });
    }

    return res.status(400).json({ success: false, error: "未知 action" });
  } catch (e) {
    console.error("[hr-holiday]", e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
}
