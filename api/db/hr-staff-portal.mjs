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
//   4. 证件：**只返回本人自己的**（0730 Damon 要"员工能看到自己签的合同和身份证"）。
//      身份证号本人可见全量；文件走 ?file=id_card|contract 从私有目录取，employee 仍只从 token 认。
import fs from "fs";
import path from "path";
import { getPool, setCors } from "./db.js";
import { verifyToken } from "./auth.js";

const D = "YYYY-MM-DD";
const UPLOAD_DIR = "/opt/sanlyn-uploads/reimbursement";
const PRIVATE_ROOT = "/opt/sanlyn-private/hr";   // 证件私有目录，不在任何 web root 内
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
      `SELECT id, name, employee_code, role, position, company_code, employment_status,
              phone, id_card_no, id_card_file, contract_file,
              to_char(contract_start,'YYYY-MM-DD') AS contract_start,
              to_char(contract_end,'YYYY-MM-DD')   AS contract_end,
              to_char(hire_date,'YYYY-MM-DD')      AS hire_date,
              pay_type, pay_rate, emergency_contact, emergency_phone
         FROM hr_employees WHERE id = $1`, [empId]);
    if (!empQ.rows.length) return res.status(404).json({ success: false, error: "员工不存在" });
    const me = empQ.rows[0];
    if (me.employment_status !== "active") {
      return res.status(403).json({ success: false, error: "该员工已离职，链接停用" });
    }

    // 本人证件文件（私有目录；employee 只从 token 取，拿不到别人的）
    if (req.method === "GET" && req.query?.file) {
      const kindMap = { id_card: me.id_card_file, contract: me.contract_file };
      const rel = kindMap[req.query.file];
      if (rel === undefined) return res.status(400).json({ success:false, error:"file 只能是 id_card 或 contract" });
      if (!rel) return res.status(404).json({ success:false, error:"还没上传这个文件，找店长补" });
      const abs = path.resolve(PRIVATE_ROOT, rel);
      if (!abs.startsWith(PRIVATE_ROOT + path.sep)) return res.status(400).json({ success:false, error:"非法路径" });
      if (!fs.existsSync(abs)) return res.status(404).json({ success:false, error:"文件不存在" });
      const ext = path.extname(abs).toLowerCase();
      res.setHeader("Content-Type", ext===".pdf"?"application/pdf":ext===".png"?"image/png":"image/jpeg");
      res.setHeader("Cache-Control", "private, no-store");
      return res.end(fs.readFileSync(abs));
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
      const today = new Date(Date.now() + 8*3600*1000).toISOString().slice(0,10);
      const todayCk = await pool.query(
        `SELECT id, checkin_at, checkout_at, source FROM hr_staff_checkin
          WHERE employee_ref=$1 AND checkin_date=$2 ORDER BY checkin_at DESC LIMIT 1`, [empId, today]);
      return res.status(200).json({
        success: true, today,
        today_checkin: todayCk.rows[0] || null,
        me: { name: me.name, employee_code: me.employee_code, position: me.position || null,
              role: me.role, company_code: me.company_code,
              phone: me.phone, id_card_no: me.id_card_no,
              has_id_card: !!me.id_card_file, has_contract: !!me.contract_file,
              contract_start: me.contract_start, contract_end: me.contract_end,
              hire_date: me.hire_date, pay_type: me.pay_type, pay_rate: me.pay_rate,
              emergency_contact: me.emergency_contact, emergency_phone: me.emergency_phone },
        month,
        shifts: shifts.rows, leaves: leaves.rows, reimbursements: reimb.rows,
        payslips: pay.rows, overtime: ot.rows, handbook: book.rows,
      });
    }

    if (req.method === "POST") {
      const b = req.body || {};
      const action = b.action;

      // 扫墙上二维码打卡（必须人在店里才扫得到）
      if (action === "checkin" || action === "checkout") {
        const code = String(b.code || "").trim();
        const pt = await pool.query(
          "SELECT code,label FROM hr_checkin_points WHERE code=$1 AND company_code=$2 AND is_active=true",
          [code, me.company_code]);
        if (!pt.rows.length) return res.status(400).json({ success:false, error:"二维码无效，请扫店里墙上那个" });
        const today = new Date(Date.now() + 8*3600*1000).toISOString().slice(0,10);
        const exist = await pool.query(
          "SELECT id, checkin_at, checkout_at FROM hr_staff_checkin WHERE employee_ref=$1 AND checkin_date=$2 LIMIT 1",
          [empId, today]);
        if (action === "checkin") {
          if (exist.rows.length) return res.status(200).json({ success:true, already:true,
            message:`今天已经打过卡了（${String(exist.rows[0].checkin_at).slice(11,16)}）` });
          await pool.query(
            `INSERT INTO hr_staff_checkin (id, company_code, employee_ref, staff_name, checkin_date, checkin_at, source, scan_code, store_code)
             VALUES ($1,$2,$3,$4,$5,now(),'qr',$6,$7)`,
            [`qr-${empId}-${today}`, me.company_code, empId, me.name, today, code, me.company_code]);
          return res.status(200).json({ success:true, message:`上班打卡成功 · ${pt.rows[0].label}` });
        }
        if (!exist.rows.length) return res.status(400).json({ success:false, error:"今天还没上班打卡" });
        if (exist.rows[0].checkout_at) return res.status(200).json({ success:true, already:true, message:"今天已经打过下班卡了" });
        await pool.query("UPDATE hr_staff_checkin SET checkout_at=now() WHERE id=$1", [exist.rows[0].id]);
        return res.status(200).json({ success:true, message:"下班打卡成功，辛苦了 🐾" });
      }

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

      return res.status(400).json({ success: false, error: "action 只能是 checkin / checkout / leave / reimbursement / overtime" });
    }

    return res.status(405).json({ success: false, error: "不支持的方法" });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
