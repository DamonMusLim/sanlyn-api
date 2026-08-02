// /api/db/hr-recruit.mjs — 招聘管理端（需登录）：看应聘者 / 改职位与面试问题 / 一键录用建档
//   GET  ?view=applicants|job   PATCH {kind:'job'|'applicant', ...}   POST {action:'hire', id}
// 录用 = 把应聘者资料直接写进 hr_employees（免二次录入）+ 回填 hired_employee_id + 记一条 hire 异动。
import fs from "fs";
import path from "path";
import { getPool, setCors } from "./db.js";

const UPLOAD_DIR = "/opt/sanlyn-uploads/handbook";   // 环境照片与手册同目录（都是内部非隐私图）
const PUBLIC_HOST = "https://ai.sanlyn.cn";

function saveImage(filename, mime, dataB64) {
  if (!/^image\//.test(String(mime || ""))) throw new Error("只支持图片");
  const buf = Buffer.from(dataB64, "base64");
  if (buf.length > 8 * 1024 * 1024) throw new Error("图片超过8MB");
  const dir = path.join(UPLOAD_DIR, "job-" + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(filename || "img").replace(/[^a-zA-Z0-9._一-龥-]/g, "_");
  fs.writeFileSync(path.join(dir, safe), buf);
  return `${PUBLIC_HOST}/uploads/handbook/${path.basename(dir)}/${safe}`;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();
  const company = req.query?.company_code || req.body?.company_code || "JINFANG";

  try {
    if (req.method === "GET") {
      if (req.query?.view === "job") {
        const r = await pool.query("SELECT * FROM hr_job_posts WHERE company_code=$1 ORDER BY id", [company]);
        return res.status(200).json({ success: true, data: r.rows });
      }
      const { status } = req.query;
      const params = [company]; const conds = ["company_code=$1"];
      if (status) { params.push(status); conds.push(`status=$${params.length}`); }
      const r = await pool.query(
        `SELECT id, job_post_id, name, phone, gender, birth_year, intro,
                available_days, available_shifts, to_char(earliest_start,'YYYY-MM-DD') AS earliest_start,
                expected_pay, answers, status, review_note, reviewed_by, hired_employee_id, created_at
           FROM hr_applicants WHERE ${conds.join(" AND ")}
          ORDER BY created_at DESC LIMIT 500`, params);
      const c = await pool.query(
        `SELECT COUNT(*) total, COUNT(*) FILTER (WHERE status='new') AS fresh,
                COUNT(*) FILTER (WHERE status='interview') AS interview
           FROM hr_applicants WHERE company_code=$1`, [company]);
      return res.status(200).json({ success: true, data: r.rows, count: r.rows.length, stats: c.rows[0] });
    }

    if (req.method === "PATCH") {
      const b = req.body || {};
      if (b.kind === "job") {
        if (!b.id) return res.status(400).json({ success: false, error: "id 必填" });
        const sets = [], params = [];
        for (const k of ["title", "intro", "requirements", "pay_range", "work_place", "is_open"]) {
          if (k in b) { params.push(b[k]); sets.push(`${k}=$${params.length}`); }
        }
        for (const k of ["questions", "shift_options"]) {
          if (k in b) { params.push(JSON.stringify(b[k] || [])); sets.push(`${k}=$${params.length}`); }
        }
        if ("images" in b) {
          const out = [];
          for (const im of b.images || []) {
            if (im?.base64) { try { out.push({ url: saveImage(im.filename, im.mime, im.base64), caption: im.caption || "" }); }
              catch (e) { return res.status(400).json({ success: false, error: e.message }); } }
            else if (im?.url) out.push({ url: im.url, caption: im.caption || "" });
          }
          params.push(JSON.stringify(out)); sets.push(`images=$${params.length}`);
        }
        if (!sets.length) return res.status(400).json({ success: false, error: "无可更新字段" });
        sets.push("updated_at=now()");
        params.push(b.id);
        const r = await pool.query(`UPDATE hr_job_posts SET ${sets.join(", ")} WHERE id=$${params.length} RETURNING *`, params);
        return res.status(200).json({ success: true, data: r.rows[0] });
      }
      // 应聘者：只允许改审批相关，不能改他填的内容
      if (!b.id) return res.status(400).json({ success: false, error: "id 必填" });
      const sets = [], params = [];
      for (const k of ["status", "review_note", "reviewed_by"]) {
        if (k in b) { params.push(b[k]); sets.push(`${k}=$${params.length}`); }
      }
      if (!sets.length) return res.status(400).json({ success: false, error: "仅允许更新 status/review_note/reviewed_by" });
      params.push(new Date().toISOString()); sets.push(`reviewed_at=$${params.length}`);
      params.push(b.id);
      const r = await pool.query(`UPDATE hr_applicants SET ${sets.join(", ")} WHERE id=$${params.length} RETURNING *`, params);
      if (!r.rows.length) return res.status(404).json({ success: false, error: "应聘者不存在" });
      return res.status(200).json({ success: true, data: r.rows[0] });
    }

    // 一键录用：应聘资料 → hr_employees（不用重打一遍）
    if (req.method === "POST" && req.body?.action === "hire") {
      const { id, pay_type, pay_rate, hire_date, role, position } = req.body;
      if (!id) return res.status(400).json({ success: false, error: "id 必填" });
      const a = (await pool.query("SELECT * FROM hr_applicants WHERE id=$1", [id])).rows[0];
      if (!a) return res.status(404).json({ success: false, error: "应聘者不存在" });
      if (a.hired_employee_id) return res.status(400).json({ success: false, error: "已录用过，别重复建档" });

      // 岗位:店长录用时可以改;不传就沿用应聘时选的意向。
      // ⚠️ role(权限) 跟 position(叫法) 是两回事 —— role=manager 只能由 CEO 在这里显式写,
      //    公网自申请只能影响 position 这个称呼,拿不到管理权。
      const pos = position || a.desired_position || null;
      const emp = await pool.query(
        `INSERT INTO hr_employees (company_code,name,phone,role,position,pay_type,pay_rate,hire_date,employment_status)
         VALUES ($1,$2,$3,COALESCE($4,'clerk'),$5,COALESCE($6,'daily'),$7,$8,'active') RETURNING id,name,position`,
        [a.company_code, a.name, a.phone, role || null, pos, pay_type || null,
         pay_rate == null || pay_rate === "" ? null : pay_rate,
         hire_date || new Date().toISOString().slice(0, 10)]);
      const empId = emp.rows[0].id;

      await pool.query(
        `INSERT INTO hr_employee_events (company_code,employee_id,employee_name,event_type,event_date,note)
         VALUES ($1,$2,$3,'hire',$4,$5)`,
        [a.company_code, empId, a.name, hire_date || new Date().toISOString().slice(0, 10),
         `由应聘者#${id}录用；可上班时段：${(a.available_shifts || []).join("/") || "未填"}`]);
      await pool.query("UPDATE hr_applicants SET status='hired', hired_employee_id=$1, reviewed_at=now() WHERE id=$2", [empId, id]);

      return res.status(200).json({ success: true, data: { employee_id: empId, name: emp.rows[0].name },
        message: "已建档到员工花名册。记得去花名册补身份证/合同/薪资标准。" });
    }

    return res.status(405).json({ success: false, error: "不支持的方法" });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
}
