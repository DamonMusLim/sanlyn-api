// /api/db/hr-staff-portal.mjs — 集团HRM · 员工自助（店员手机端，免后台账号）
//
// 认证：复用现有 JWT，但发的是**限权 token**（role=staff + employee_id），不是后台账号。
//   GET  ?token=<jwt>              → 我的排班/我的请假/我的报销/我的工资条（只返回自己那份）
//   POST ?token=<jwt> {action:...} → 提交请假 / 提交报销(带小票) / 提交加班
//
// 🔒 安全铁律（这个接口是**对外**的，店员手机能直接打）：
//   1. employee_id 一律取自 **token 内**，绝不信任 body/query 里传来的 —— 否则改个数字就能看别人工资。
//   2. 只允许 submit 类动作，**不含任何审批权**（status 恒为 pending，店长在后台批）。
//   3. 工资条只返回 confirmed/paid 的，草稿不给看（避免店员看到试算中的数字来吵）。
//   4. 不返回身份证号/证件文件（那是 HR 侧数据，员工自己端不需要，减少泄露面）。
import fs from "fs";
import path from "path";
import { getPool, setCors } from "./db.js";
import { verifyToken } from "./auth.js";

const D = "YYYY-MM-DD";
const UPLOAD_DIR = "/opt/sanlyn-uploads/reimbursement";
const PUBLIC_HOST = "https://ai.sanlyn.cn";
const MAX_BYTES = 6 * 1024 * 1024;

function saveReceipt(filename, mime, dataB64) {
  if (!/^image\//.test(String(mime || ""))) throw new Error("小票只能是图片");
  const buf = Buffer.from(dataB64, "base64");
  if (buf.length > MAX_BYTES) throw new Error("图片超过6MB");
  const dir = path.join(UPLOAD_DIR, String(Date.now()));
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(filename || "receipt").replace(/[^a-zA-Z0-9._一-龥-]/g, "_");
  fs.writeFileSync(path.join(dir, safe), buf);
  return `${PUBLIC_HOST}/uploads/reimbursement/${path.basename(dir)}/${safe}`;
}

function monthOf(v) {
  if (/^\d{4}-\d{2}$/.test(String(v || ""))) return v;
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // ── 认证：只认 role=staff 的限权 token，employee_id 只从 token 取 ──
  const raw = req.query?.token || (req.headers.authorization || "").replace(/^Bearer /, "");
  const claims = verifyToken(raw);
  if (!claims || claims.role !== "staff" || !claims.employee_id) {
    return res.status(401).json({ success: false, error: "链接无效或已过期，找店长重新发一个" });
  }
  const empId = claims.employee_id;
  const pool = getPool();

  try {
    const empQ = await pool.query(
      `SELECT id, name, employee_code, role, position, company_code, employment_status
         FROM hr_employees WHERE id = $1`, [empId]);
    if (!empQ.rows.length) return res.status(404).json({ success: false, error: "员工不存在" });
    const me = empQ.rows[0];
    if (me.employment_status !== "active") {
      return res.status(403).json({ success: false, error: "该员工已离职，链接停用" });
    }

    if (req.method === "GET") {
      const month = monthOf(req.query?.month);
      const from = `${month}-01`, to = `${month}-31`;
      const [shifts, leaves, reimb, pay, ot, book] = await Promise.all([
        pool.query(`SELECT to_char(work_date,'${D}') AS work_date, start_time, end_time, shift_label, is_rest_day
                      FROM hr_shifts WHERE employee_id=$1 AND work_date BETWEEN $2 AND $3 ORDER BY work_date`,
          [empId, from, to]),
        pool.query(`SELECT id, to_char(leave_date_start,'${D}') AS leave_date_start,
                           to_char(leave_date_end,'${D}') AS leave_date_end, reason, status, review_note
                      FROM hr_leave_requests WHERE employee_id=$1 ORDER BY created_at DESC LIMIT 30`, [empId]),
        pool.query(`SELECT id, amount, item_desc, to_char(purchase_date,'${D}') AS purchase_date, status, review_note
                      FROM hr_reimbursements WHERE employee_id=$1 ORDER BY created_at DESC LIMIT 30`, [empId]),
        // 工资条只给已确认/已发放的，草稿不给看
        pool.query(`SELECT period, pay_type, actual_days, actual_hours, overtime_hours,
                           base_amount, overtime_amount, gross_amount, reimb_amount, status,
                           to_char(paid_at,'${D}') AS paid_at
                      FROM hr_payroll WHERE employee_id=$1 AND status IN ('confirmed','paid')
                     ORDER BY period DESC LIMIT 12`, [empId]),
        pool.query(`SELECT id, to_char(work_date,'${D}') AS work_date, hours, kind, status
                      FROM hr_overtime WHERE employee_id=$1 ORDER BY work_date DESC LIMIT 20`, [empId]),
        // 员工手册/门店问题库：只给已发布 + 该员工可见等级（店长能多看 manager 级）
        pool.query(
          `SELECT id, category, title, body, images, tags
             FROM hr_handbook
            WHERE company_code=$1 AND is_published=true
              AND (visibility='all' OR ($2 = 'store_manager' AND visibility='manager'))
            ORDER BY category, sort_order, id LIMIT 200`,
          [me.company_code, me.role]),
      ]);
      return res.status(200).json({
        success: true,
        me: { name: me.name, employee_code: me.employee_code, position: me.position || null,
              role: me.role, company_code: me.company_code },
        month,
        shifts: shifts.rows, leaves: leaves.rows, reimbursements: reimb.rows,
        payslips: pay.rows, overtime: ot.rows, handbook: book.rows,
      });
    }

    if (req.method === "POST") {
      const b = req.body || {};
      const action = b.action;

      if (action === "leave") {
        if (!b.leave_date_start || !b.leave_date_end)
          return res.status(400).json({ success: false, error: "请假起止日期必填" });
        const r = await pool.query(
          `INSERT INTO hr_leave_requests
             (company_code, employee_id, employee_name, leave_date_start, leave_date_end, reason, status)
           VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING id, status`,
          [me.company_code, empId, me.name, b.leave_date_start, b.leave_date_end, b.reason || null]);
        return res.status(200).json({ success: true, data: r.rows[0], message: "已提交，等店长审批" });
      }

      if (action === "reimbursement") {
        if (!b.amount) return res.status(400).json({ success: false, error: "金额必填" });
        let url = null;
        if (b.receipt_base64) {
          try { url = saveReceipt(b.receipt_filename, b.receipt_mime, b.receipt_base64); }
          catch (e) { return res.status(400).json({ success: false, error: e.message }); }
        }
        const r = await pool.query(
          `INSERT INTO hr_reimbursements
             (company_code, employee_id, employee_name, amount, item_desc, purchase_date, receipt_url, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id, status`,
          [me.company_code, empId, me.name, b.amount, b.item_desc || null, b.purchase_date || null, url]);
        return res.status(200).json({ success: true, data: r.rows[0], message: "已提交，等店长审批" });
      }

      if (action === "overtime") {
        if (!b.work_date || !b.hours)
          return res.status(400).json({ success: false, error: "日期和时数必填" });
        const r = await pool.query(
          `INSERT INTO hr_overtime (company_code, employee_id, employee_name, work_date, hours, kind, reason, status)
           VALUES ($1,$2,$3,$4,$5,COALESCE($6,'overtime'),$7,'pending') RETURNING id, status`,
          [me.company_code, empId, me.name, b.work_date, b.hours, b.kind || null, b.reason || null]);
        return res.status(200).json({ success: true, data: r.rows[0], message: "已提交，等店长审批" });
      }

      return res.status(400).json({ success: false, error: "action 只能是 leave / reimbursement / overtime" });
    }

    return res.status(405).json({ success: false, error: "不支持的方法" });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
