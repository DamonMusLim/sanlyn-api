// /api/db/hr-overtime.mjs — 集团HRM · 加班/调休（审批制，已批的才进算薪）
// GET ?company_code&status&date_from&date_to / POST 提交 / PATCH 审批(只开放 status/reviewed_by)
import { getPool, setCors } from "./db.js";
const D = "YYYY-MM-DD";
const APPROVAL = ["status", "reviewed_by"];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();
  const company = req.query?.company_code || req.body?.company_code || "JINFANG";
  try {
    if (req.method === "GET") {
      const { status, date_from, date_to, limit = 500 } = req.query;
      const params = [company]; const conds = ["company_code=$1"];
      if (status) { params.push(status); conds.push(`status=$${params.length}`); }
      if (date_from) { params.push(date_from); conds.push(`work_date>=$${params.length}`); }
      if (date_to) { params.push(date_to); conds.push(`work_date<=$${params.length}`); }
      params.push(Math.min(parseInt(limit) || 500, 2000));
      const r = await pool.query(
        `SELECT id, employee_id, employee_name, to_char(work_date,'${D}') AS work_date, hours, kind,
                reason, status, reviewed_by, reviewed_at, created_at
           FROM hr_overtime WHERE ${conds.join(" AND ")}
          ORDER BY work_date DESC LIMIT $${params.length}`, params);
      const c = await pool.query(
        `SELECT COUNT(*) total, COUNT(*) FILTER (WHERE status='pending') pending,
                COALESCE(SUM(hours) FILTER (WHERE status='approved' AND kind='overtime'),0) ot_hours
           FROM hr_overtime WHERE company_code=$1`, [company]);
      return res.status(200).json({ success: true, data: r.rows, count: parseInt(c.rows[0].total), stats: c.rows[0] });
    }
    if (req.method === "POST") {
      const b = req.body || {};
      if (!b.employee_name || !b.work_date || !b.hours)
        return res.status(400).json({ success: false, error: "employee_name/work_date/hours 必填" });
      const r = await pool.query(
        `INSERT INTO hr_overtime (company_code,employee_id,employee_name,work_date,hours,kind,reason)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6,'overtime'),$7) RETURNING *`,
        [company, b.employee_id || null, b.employee_name, b.work_date, b.hours, b.kind || null, b.reason || null]);
      return res.status(200).json({ success: true, data: r.rows[0] });
    }
    if (req.method === "PATCH") {
      const b = req.body || {};
      if (!b.id) return res.status(400).json({ success: false, error: "id 必填" });
      const sets = [], params = [];
      for (const k of APPROVAL) if (k in b) { params.push(b[k]); sets.push(`${k}=$${params.length}`); }
      if (!sets.length) return res.status(400).json({ success: false, error: "仅允许更新审批字段" });
      if (b.status === "approved" || b.status === "rejected") {
        params.push(new Date().toISOString()); sets.push(`reviewed_at=$${params.length}`);
      }
      params.push(b.id);
      const r = await pool.query(`UPDATE hr_overtime SET ${sets.join(", ")} WHERE id=$${params.length} RETURNING *`, params);
      if (!r.rows.length) return res.status(404).json({ success: false, error: "记录不存在" });
      return res.status(200).json({ success: true, data: r.rows[0] });
    }
    return res.status(405).json({ success: false, error: "不支持的方法" });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
}
