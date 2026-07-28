// /api/db/hr-payroll.mjs — 集团HRM · 薪酬算薪（月度工资单）
// GET  ?period=YYYY-MM[&company_code=]  → 该月工资单列表
// POST {period, company_code}           → 按排班工时/出勤/请假/加班/报销【试算】并落草稿(幂等,重算覆盖draft)
// PATCH {id, ...}                       → 改单条(金额微调/备注/状态 draft→confirmed→paid)
//
// 计薪三种，按人配 hr_employees.pay_type：
//   monthly 月薪 → pay_rate ÷ 标准月天数 × 实际出勤天  (缺勤按天扣)
//   daily   日薪 → pay_rate × 实际出勤天
//   hourly  时薪 → pay_rate × 实际工时
// 加班另计 = 时薪 × 加班时数 × 加班倍数(组织配置,默认1.5)；月薪/日薪的时薪按 pay_rate 折算。
// ⚠️出勤天数口径：**有打卡记录才算实际出勤**；打卡链路没跑起来时会全是0 → 接口返回 basis 说明用的哪种口径，
//   并在 warnings 里点名，绝不让"0出勤=0工资"这种假数悄悄变成工资单。
import { getPool, setCors } from "./db.js";

const D = "YYYY-MM-DD";

function monthRange(period) {
  const m = /^\d{4}-\d{2}$/.test(String(period || "")) ? period : null;
  if (!m) throw new Error("period 必须是 YYYY-MM");
  const [y, mo] = m.split("-").map(Number);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { from: `${m}-01`, to: `${m}-${String(last).padStart(2, "0")}`, label: m };
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function shiftHours(s) {
  if (s.is_rest_day || !s.start_time || !s.end_time) return 0;
  const [sh, sm] = String(s.start_time).split(":").map(Number);
  const [eh, em] = String(s.end_time).split(":").map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins < 0) mins += 1440;
  return mins / 60;
}

// 按 UTC 展开日期区间（本地解析会因 UTC+8 退一天，见 reference_pg_date_utc_shift_trap）
function expandDates(from, to, set) {
  let d = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  while (d <= end) { set.add(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 86400000); }
}

async function computeOne(pool, emp, range, cfg) {
  const [shifts, checkins, leaves, ot, reimb] = await Promise.all([
    pool.query(`SELECT to_char(work_date,'${D}') AS work_date, start_time, end_time, is_rest_day
                  FROM hr_shifts WHERE employee_id=$1 AND work_date BETWEEN $2 AND $3`,
      [emp.id, range.from, range.to]),
    pool.query(`SELECT to_char(checkin_date,'${D}') AS d FROM hr_staff_checkin
                 WHERE staff_name=$1 AND checkin_date BETWEEN $2 AND $3`,
      [emp.name, range.from, range.to]),
    pool.query(`SELECT to_char(leave_date_start,'${D}') AS s, to_char(leave_date_end,'${D}') AS e
                  FROM hr_leave_requests WHERE employee_id=$1 AND status='approved'
                   AND leave_date_start<=$3 AND leave_date_end>=$2`,
      [emp.id, range.from, range.to]),
    pool.query(`SELECT kind, COALESCE(SUM(hours),0) AS h FROM hr_overtime
                 WHERE employee_id=$1 AND status='approved' AND work_date BETWEEN $2 AND $3
                 GROUP BY kind`, [emp.id, range.from, range.to]),
    pool.query(`SELECT COALESCE(SUM(amount),0) AS a FROM hr_reimbursements
                 WHERE employee_id=$1 AND status='approved' AND purchase_date BETWEEN $2 AND $3`,
      [emp.id, range.from, range.to]),
  ]);

  const work = shifts.rows.filter((s) => !s.is_rest_day);
  const scheduledDates = new Set(work.map((s) => s.work_date));
  const scheduledHours = work.reduce((n, s) => n + shiftHours(s), 0);
  const checkinDates = new Set(checkins.rows.map((r) => r.d));

  const leaveDates = new Set();
  for (const l of leaves.rows) expandDates(l.s, l.e, leaveDates);
  const leaveDays = [...leaveDates].filter((d) => scheduledDates.has(d)).length;

  const overtimeHours = Number(ot.rows.find((r) => r.kind === "overtime")?.h || 0);
  const compOffHours = Number(ot.rows.find((r) => r.kind === "comp_off")?.h || 0);
  const reimbAmount = Number(reimb.rows[0]?.a || 0);

  // 出勤口径：有打卡就以打卡为准；整月零打卡则退回"按排班计"并明确告警（防0工资假数）
  const warnings = [];
  let actualDays, basis;
  if (checkinDates.size > 0) {
    actualDays = [...scheduledDates].filter((d) => checkinDates.has(d)).length + leaveDays;
    basis = "checkin";
  } else {
    actualDays = scheduledDates.size;
    basis = "schedule";
    if (scheduledDates.size > 0) warnings.push("整月无打卡记录，出勤按【排班】计（打卡链路未启用时的兜底，非真实到岗）");
  }
  // 工时同理
  const actualHours = basis === "checkin"
    ? work.filter((s) => checkinDates.has(s.work_date)).reduce((n, s) => n + shiftHours(s), 0)
    : scheduledHours;

  const rate = Number(emp.pay_rate || 0);
  if (!rate) warnings.push("未设薪资标准(pay_rate)，本行金额为0，去员工花名册补");

  let baseAmount = 0, hourlyRate = 0;
  if (emp.pay_type === "monthly") {
    const std = Number(cfg.standard_month_days) || 26;
    baseAmount = rate / std * actualDays;
    hourlyRate = rate / std / 8;
  } else if (emp.pay_type === "hourly") {
    baseAmount = rate * actualHours;
    hourlyRate = rate;
  } else { // daily
    baseAmount = rate * actualDays;
    hourlyRate = rate / 8;
  }
  const overtimeAmount = hourlyRate * overtimeHours * (Number(cfg.overtime_multiplier) || 1.5);
  if (compOffHours > 0) warnings.push(`有${compOffHours}小时调休(不计入工资，只抵休息)`);

  return {
    employee_id: emp.id, employee_name: emp.name,
    pay_type: emp.pay_type, pay_rate: rate,
    scheduled_days: scheduledDates.size, actual_days: actualDays,
    actual_hours: round2(actualHours), leave_days: leaveDays,
    overtime_hours: overtimeHours,
    base_amount: round2(baseAmount), overtime_amount: round2(overtimeAmount),
    commission_amount: 0, deduction_amount: 0, reimb_amount: round2(reimbAmount),
    gross_amount: round2(baseAmount + overtimeAmount),
    basis, warnings,
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();
  const company = (req.query?.company_code) || (req.body?.company_code) || "JINFANG";

  try {
    const cfgQ = await pool.query("SELECT * FROM hr_org_settings WHERE company_code=$1", [company]);
    const cfg = cfgQ.rows[0] || { standard_month_days: 26, overtime_multiplier: 1.5 };

    if (req.method === "GET") {
      const { period } = req.query;
      const params = [company];
      let sql = `SELECT * FROM hr_payroll WHERE company_code=$1`;
      if (period) { params.push(period); sql += ` AND period=$${params.length}`; }
      sql += " ORDER BY period DESC, employee_name";
      const r = await pool.query(sql, params);
      const totals = r.rows.reduce((t, x) => ({
        gross: round2(t.gross + Number(x.gross_amount || 0)),
        reimb: round2(t.reimb + Number(x.reimb_amount || 0)),
      }), { gross: 0, reimb: 0 });
      return res.status(200).json({ success: true, data: r.rows, count: r.rows.length, totals, config: cfg });
    }

    // 试算并落草稿（幂等：同 period 重跑覆盖 draft，已 confirmed/paid 的不动）
    if (req.method === "POST") {
      const range = monthRange(req.body?.period);
      const emps = await pool.query(
        `SELECT id,name,pay_type,pay_rate FROM hr_employees
          WHERE company_code=$1 AND employment_status='active' ORDER BY name`, [company]);
      const out = [];
      const skipped = [];
      for (const emp of emps.rows) {
        const locked = await pool.query(
          `SELECT status FROM hr_payroll WHERE company_code=$1 AND employee_id=$2 AND period=$3`,
          [company, emp.id, range.label]);
        if (locked.rows.length && locked.rows[0].status !== "draft") {
          skipped.push(`${emp.name}(已${locked.rows[0].status === "paid" ? "发放" : "确认"}，未覆盖)`);
          continue;
        }
        const c = await computeOne(pool, emp, range, cfg);
        const up = await pool.query(
          `INSERT INTO hr_payroll (company_code,employee_id,employee_name,period,pay_type,pay_rate,
             scheduled_days,actual_days,actual_hours,leave_days,overtime_hours,
             base_amount,overtime_amount,commission_amount,deduction_amount,reimb_amount,gross_amount,status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,0,$14,$15,'draft')
           ON CONFLICT (company_code,employee_id,period) DO UPDATE SET
             pay_type=EXCLUDED.pay_type, pay_rate=EXCLUDED.pay_rate,
             scheduled_days=EXCLUDED.scheduled_days, actual_days=EXCLUDED.actual_days,
             actual_hours=EXCLUDED.actual_hours, leave_days=EXCLUDED.leave_days,
             overtime_hours=EXCLUDED.overtime_hours, base_amount=EXCLUDED.base_amount,
             overtime_amount=EXCLUDED.overtime_amount, reimb_amount=EXCLUDED.reimb_amount,
             gross_amount=EXCLUDED.gross_amount
           RETURNING *`,
          [company, emp.id, emp.name, range.label, c.pay_type, c.pay_rate,
           c.scheduled_days, c.actual_days, c.actual_hours, c.leave_days, c.overtime_hours,
           c.base_amount, c.overtime_amount, c.reimb_amount, c.gross_amount]
        );
        out.push({ ...up.rows[0], basis: c.basis, warnings: c.warnings });
      }
      return res.status(200).json({
        success: true, data: out, period: range.label, skipped,
        note: "已生成草稿。确认无误后逐条改 confirmed，再标 paid。重跑只覆盖 draft。",
      });
    }

    if (req.method === "PATCH") {
      const b = req.body || {};
      if (!b.id) return res.status(400).json({ success: false, error: "id 必填" });
      const allowed = ["commission_amount", "deduction_amount", "gross_amount", "status", "note"];
      const sets = [], params = [];
      for (const k of allowed) if (k in b) { params.push(b[k]); sets.push(`${k}=$${params.length}`); }
      if (b.status === "paid") { params.push(new Date().toISOString()); sets.push(`paid_at=$${params.length}`); }
      if (!sets.length) return res.status(400).json({ success: false, error: "无可更新字段" });
      params.push(b.id);
      const r = await pool.query(`UPDATE hr_payroll SET ${sets.join(", ")} WHERE id=$${params.length} RETURNING *`, params);
      if (!r.rows.length) return res.status(404).json({ success: false, error: "工资单不存在" });
      return res.status(200).json({ success: true, data: r.rows[0] });
    }

    return res.status(405).json({ success: false, error: "不支持的方法" });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
