// /api/db/hr-profile.mjs — 金枋宠物店 HRM 串联层（以员工为主线的 360 视图）
// GET ?employee_id=X&month=YYYY-MM  → 一个人一个月的：排班/打卡/请假/报销 + 交叉核对统计
// GET ?month=YYYY-MM（不传 employee_id）→ 全员汇总一览（HRM 总览面板）
// 只读聚合，不写任何表。
//
// ⚠️打卡关联的已知弱点：mini 源表 staff_checkin 只有 staff_name 自由文本、无工号，
// 故打卡只能按【姓名字面匹配】挂到员工上。改名/同名会断。要根治须在打卡录入端接花名册选人。
import { getPool, setCors } from "./db.js";

function monthRange(month) {
  const m = /^\d{4}-\d{2}$/.test(String(month || "")) ? month : null;
  if (!m) {
    const now = new Date();
    const y = now.getFullYear();
    const mo = String(now.getMonth() + 1).padStart(2, "0");
    return { from: `${y}-${mo}-01`, to: `${y}-${mo}-31`, label: `${y}-${mo}` };
  }
  return { from: `${m}-01`, to: `${m}-31`, label: m };
}

const D = "YYYY-MM-DD";

async function oneProfile(pool, employeeId, range) {
  const emp = await pool.query(
    "SELECT id, employee_code, name, role, employment_status, store_id FROM hr_employees WHERE id = $1",
    [employeeId]
  );
  if (!emp.rows.length) return null;
  const e = emp.rows[0];

  const [shifts, checkins, leaves, reimb] = await Promise.all([
    pool.query(
      `SELECT id, to_char(work_date,'${D}') AS work_date, start_time, end_time, shift_label, is_rest_day, note
         FROM hr_shifts WHERE employee_id = $1 AND work_date BETWEEN $2 AND $3
        ORDER BY work_date`,
      [employeeId, range.from, range.to]
    ),
    // 打卡只能按姓名匹配（见文件头警告）
    pool.query(
      `SELECT id, to_char(checkin_date,'${D}') AS checkin_date, checkin_at, face_status, face_score, note
         FROM hr_staff_checkin WHERE staff_name = $1 AND checkin_date BETWEEN $2 AND $3
        ORDER BY checkin_date`,
      [e.name, range.from, range.to]
    ),
    pool.query(
      `SELECT id, to_char(leave_date_start,'${D}') AS leave_date_start,
              to_char(leave_date_end,'${D}') AS leave_date_end, reason, status, reviewed_by
         FROM hr_leave_requests
        WHERE employee_id = $1 AND leave_date_start <= $3 AND leave_date_end >= $2
        ORDER BY leave_date_start`,
      [employeeId, range.from, range.to]
    ),
    pool.query(
      `SELECT id, amount, item_desc, to_char(purchase_date,'${D}') AS purchase_date, receipt_url, status
         FROM hr_reimbursements WHERE employee_id = $1
          AND (purchase_date BETWEEN $2 AND $3 OR purchase_date IS NULL)
        ORDER BY created_at DESC`,
      [employeeId, range.from, range.to]
    ),
  ]);

  const hoursOf = (s) => {
    if (s.is_rest_day || !s.start_time || !s.end_time) return 0;
    const [sh, sm] = String(s.start_time).split(":").map(Number);
    const [eh, em] = String(s.end_time).split(":").map(Number);
    let mins = (eh * 60 + em) - (sh * 60 + sm);
    if (mins < 0) mins += 1440;
    return mins / 60;
  };

  const workShifts = shifts.rows.filter((s) => !s.is_rest_day);
  const scheduledDates = new Set(workShifts.map((s) => s.work_date));
  const checkinDates = new Set(checkins.rows.map((c) => c.checkin_date));

  // 请假覆盖的日期（已批准的才算）
  // ⚠️必须带 "Z" 按 UTC 解析：服务器是 UTC+8，若按本地时间解析，toISOString() 转回 UTC 会退一天
  // （踩过：8/6 的假展开成 8/5，导致缺卡/冲突日期整体错位一天）。UTC进 UTC出 才能原样往返。
  const leaveDates = new Set();
  for (const l of leaves.rows) {
    if (l.status !== "approved") continue;
    let d = new Date(l.leave_date_start + "T00:00:00Z");
    const end = new Date(l.leave_date_end + "T00:00:00Z");
    while (d <= end) {
      leaveDates.add(d.toISOString().slice(0, 10));
      d = new Date(d.getTime() + 86400000);
    }
  }

  // 交叉核对：排了班但没打卡（排除已批准请假的那天）
  const missing = [...scheduledDates].filter((d) => !checkinDates.has(d) && !leaveDates.has(d)).sort();
  // 没排班却打了卡
  const unscheduled = [...checkinDates].filter((d) => !scheduledDates.has(d)).sort();
  // 已批假当天还排了班（排班冲突）
  const leaveConflict = [...scheduledDates].filter((d) => leaveDates.has(d)).sort();

  const scheduledHours = Math.round(workShifts.reduce((s, x) => s + hoursOf(x), 0) * 100) / 100;
  const sum = (rows, f) => rows.reduce((s, r) => s + (Number(r[f]) || 0), 0);

  return {
    employee: e,
    period: range,
    shifts: shifts.rows.map((s) => ({ ...s, hours: Math.round(hoursOf(s) * 100) / 100 })),
    checkins: checkins.rows,
    leaves: leaves.rows,
    reimbursements: reimb.rows,
    stats: {
      scheduled_days: scheduledDates.size,
      scheduled_hours: scheduledHours,
      rest_days: shifts.rows.filter((s) => s.is_rest_day).length,
      checkin_days: checkinDates.size,
      leave_days_approved: leaveDates.size,
      leave_pending: leaves.rows.filter((l) => l.status === "pending").length,
      missing_checkin: missing,
      unscheduled_checkin: unscheduled,
      leave_conflict: leaveConflict,
      reimb_approved_total: Math.round(sum(reimb.rows.filter((r) => r.status === "approved"), "amount") * 100) / 100,
      reimb_pending: reimb.rows.filter((r) => r.status === "pending").length,
      checkin_link_note: "打卡按姓名匹配（源表无工号）",
    },
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "只读聚合，仅支持 GET" });

  const pool = getPool();
  try {
    const { employee_id, month } = req.query;
    const range = monthRange(month);

    if (employee_id) {
      const p = await oneProfile(pool, employee_id, range);
      if (!p) return res.status(404).json({ success: false, error: "员工不存在" });
      return res.status(200).json({ success: true, data: p });
    }

    // 全员汇总（HRM 总览）
    const emps = await pool.query(
      "SELECT id FROM hr_employees WHERE employment_status = 'active' ORDER BY name"
    );
    const all = [];
    for (const row of emps.rows) {
      const p = await oneProfile(pool, row.id, range);
      if (!p) continue;
      all.push({
        employee_id: p.employee.id,
        name: p.employee.name,
        role: p.employee.role,
        ...p.stats,
      });
    }
    return res.status(200).json({
      success: true,
      data: all,
      period: range,
      totals: {
        headcount: all.length,
        scheduled_hours: Math.round(all.reduce((s, a) => s + a.scheduled_hours, 0) * 100) / 100,
        missing_checkin: all.reduce((s, a) => s + a.missing_checkin.length, 0),
        leave_conflict: all.reduce((s, a) => s + a.leave_conflict.length, 0),
        leave_pending: all.reduce((s, a) => s + a.leave_pending, 0),
        reimb_pending: all.reduce((s, a) => s + a.reimb_pending, 0),
        reimb_approved_total: Math.round(all.reduce((s, a) => s + a.reimb_approved_total, 0) * 100) / 100,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
