// /api/db/hr-leave-requests.mjs — 集团HRM · 员工请假申请+审批
// GET 列表 / POST 新建请假 / PATCH 仅限审批字段(status/review_note/reviewed_by/reviewed_at)。
import { getPool, setCors } from "./db.js";
import { requireAuth } from "./auth.js";
import { reportFailure } from "./lib/report-failure.mjs";

const APPROVAL_FIELDS = ["status", "review_note", "reviewed_by"];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  const pool = getPool();

  try {
    if (req.method === "GET") {
      const { status, employee_id, limit = 500, offset = 0 } = req.query;
      const params = [];
      const conds = [];
      if (status) { params.push(status); conds.push(`status = $${params.length}`); }
      if (employee_id) { params.push(employee_id); conds.push(`employee_id = $${params.length}`); }
      let sql = "SELECT id, employee_id, employee_name, store_id, to_char(leave_date_start,'YYYY-MM-DD') AS leave_date_start, to_char(leave_date_end,'YYYY-MM-DD') AS leave_date_end, "
              + "leave_unit, reason, status, review_note, reviewed_by, reviewed_at, created_at "
              + "FROM hr_leave_requests";
      if (conds.length) sql += " WHERE " + conds.join(" AND ");
      params.push(Math.min(parseInt(limit) || 500, 2000));
      sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
      params.push(parseInt(offset) || 0);
      sql += ` OFFSET $${params.length}`;
      const rows = await pool.query(sql, params);
      const c = await pool.query(
        "SELECT COUNT(*) AS total, count(*) FILTER (WHERE status='pending') AS pending FROM hr_leave_requests"
      );
      return res.status(200).json({ success: true, data: rows.rows, count: parseInt(c.rows[0].total), stats: c.rows[0] });
    }

    if (req.method === "POST") {
      const { employee_id, employee_name, store_id, leave_date_start, leave_date_end, leave_unit, reason } = req.body || {};
      if (!employee_name || !leave_date_start || !leave_date_end) {
        return res.status(400).json({ success: false, error: "employee_name/leave_date_start/leave_date_end 必填" });
      }
      const r = await pool.query(
        `INSERT INTO hr_leave_requests
           (employee_id, employee_name, store_id, leave_date_start, leave_date_end, leave_unit, reason)
         VALUES ($1, $2, COALESCE($3,'jinfang'), $4, $5, COALESCE($6,'day'), $7)
         RETURNING *`,
        [employee_id || null, employee_name, store_id || null, leave_date_start, leave_date_end, leave_unit || null, reason || null]
      );
      return res.status(200).json({ success: true, data: r.rows[0] });
    }

    if (req.method === "PATCH") {
      const body = req.body || {};
      const { id } = body;
      if (!id) return res.status(400).json({ success: false, error: "id 必填" });
      const sets = [];
      const params = [];
      for (const k of APPROVAL_FIELDS) {
        if (k in body) { params.push(body[k]); sets.push(`${k} = $${params.length}`); }
      }
      if (!sets.length) return res.status(400).json({ success: false, error: "仅允许更新审批字段 status/review_note/reviewed_by" });
      if (body.status === "approved" || body.status === "rejected") {
        params.push(new Date().toISOString());
        sets.push(`reviewed_at = $${params.length}`);
      }
      params.push(id);
      const sql = `UPDATE hr_leave_requests SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`;
      const r = await pool.query(sql, params);
      if (!r.rows.length) return res.status(404).json({ success: false, error: "请假记录不存在" });
      return res.status(200).json({ success: true, data: r.rows[0] });
    }

    return res.status(405).json({ success: false, error: "不支持的方法" });
  } catch (err) {
    await reportFailure("hr-leave-requests", err, {
      impact: "请假审批列表/审批动作失败",
      method: req.method,
      user: req.user?.username || req.user?.account || req.user?.sub || null,
    }, { pool });
    return res.status(500).json({ success: false, error: err.message });
  }
}
