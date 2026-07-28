// /api/db/hr-shifts.mjs — 集团HRM · 排班表（工作时间/班次）
// GET 列表(按日期区间/员工筛选) / POST 新建排班 / PATCH 编辑 / DELETE 删除。
// 纯计划表，无审批语义，店长直接排班/改班/删班。
import { getPool, setCors } from "./db.js";

// 排班必须提前 N 天发布（N 来自 hr_org_settings.shift_publish_lead_days，默认2）。
// 目的：不让店长临到头才排班/临时改班，员工没法安排生活。默认拦截，确需插班用 force:true 放行并留痕。
async function leadDays(pool, company) {
  try {
    const r = await pool.query("SELECT shift_publish_lead_days FROM hr_org_settings WHERE company_code=$1", [company]);
    return r.rows.length ? Number(r.rows[0].shift_publish_lead_days) : 2;
  } catch { return 2; }
}
function daysUntil(dateStr) {
  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  return Math.round((new Date(dateStr + "T00:00:00Z") - today) / 86400000);
}

function hoursBetween(start, end) {
  if (!start || !end) return null;
  const [sh, sm] = String(start).split(":").map(Number);
  const [eh, em] = String(end).split(":").map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60; // 跨零点班次
  return Math.round((mins / 60) * 100) / 100;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();

  try {
    if (req.method === "GET") {
      const { employee_id, date_from, date_to, limit = 1000, offset = 0 } = req.query;
      const params = [];
      const conds = [];
      if (employee_id) { params.push(employee_id); conds.push(`employee_id = $${params.length}`); }
      if (date_from) { params.push(date_from); conds.push(`work_date >= $${params.length}`); }
      if (date_to) { params.push(date_to); conds.push(`work_date <= $${params.length}`); }
      let sql = "SELECT id, employee_id, employee_name, store_id, to_char(work_date,'YYYY-MM-DD') AS work_date, start_time, end_time, "
              + "shift_label, note, is_rest_day, created_at FROM hr_shifts";
      if (conds.length) sql += " WHERE " + conds.join(" AND ");
      params.push(Math.min(parseInt(limit) || 1000, 3000));
      sql += ` ORDER BY work_date ASC, start_time ASC NULLS LAST LIMIT $${params.length}`;
      params.push(parseInt(offset) || 0);
      sql += ` OFFSET $${params.length}`;
      const r = await pool.query(sql, params);
      const rows = r.rows.map((row) => ({ ...row, hours: row.is_rest_day ? 0 : hoursBetween(row.start_time, row.end_time) }));
      const c = await pool.query("SELECT COUNT(*) FROM hr_shifts");
      return res.status(200).json({ success: true, data: rows, count: parseInt(c.rows[0].count) });
    }

    if (req.method === "POST") {
      const { employee_id, employee_name, store_id, work_date, start_time, end_time, shift_label, note, is_rest_day } = req.body || {};
      if (!employee_name || !work_date) {
        return res.status(400).json({ success: false, error: "employee_name/work_date 必填" });
      }
      const company = req.body?.company_code || "JINFANG";
      const lead = await leadDays(pool, company);
      const left = daysUntil(work_date);
      if (left < lead && !req.body?.force) {
        return res.status(422).json({
          success: false, need_force: true,
          error: `排班要提前${lead}天发布，${work_date} 只剩${left < 0 ? "已过去" + -left : left}天。` +
                 `确需临时加班/插班，勾"强制排班"再提交（会留痕）。`,
        });
      }
      const r = await pool.query(
        `INSERT INTO hr_shifts (employee_id, employee_name, store_id, work_date, start_time, end_time, shift_label, note, is_rest_day, published_at)
         VALUES ($1, $2, COALESCE($3,'jinfang'), $4, $5, $6, $7, $8, COALESCE($9,false), now()) RETURNING *`,
        [employee_id || null, employee_name, store_id || null, work_date,
         is_rest_day ? null : (start_time || null), is_rest_day ? null : (end_time || null),
         is_rest_day ? '休' : (shift_label || null),
         (req.body?.force && left < lead) ? `[强制插班·剩${left}天]${note || ""}` : (note || null),
         !!is_rest_day]
      );
      return res.status(200).json({ success: true, data: r.rows[0] });
    }

    if (req.method === "PATCH") {
      const body = req.body || {};
      const { id } = body;
      if (!id) return res.status(400).json({ success: false, error: "id 必填" });
      const allowed = ["employee_id", "employee_name", "work_date", "start_time", "end_time", "shift_label", "note", "is_rest_day"];
      const sets = [];
      const params = [];
      for (const k of allowed) {
        if (k in body) { params.push(body[k]); sets.push(`${k} = $${params.length}`); }
      }
      if (!sets.length) return res.status(400).json({ success: false, error: "无可更新字段" });
      params.push(id);
      const sql = `UPDATE hr_shifts SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`;
      const r = await pool.query(sql, params);
      if (!r.rows.length) return res.status(404).json({ success: false, error: "排班记录不存在" });
      return res.status(200).json({ success: true, data: r.rows[0] });
    }

    if (req.method === "DELETE") {
      const { id } = req.query;
      if (!id) return res.status(400).json({ success: false, error: "id 必填" });
      const r = await pool.query("DELETE FROM hr_shifts WHERE id = $1 RETURNING id", [id]);
      if (!r.rows.length) return res.status(404).json({ success: false, error: "排班记录不存在" });
      return res.status(200).json({ success: true, data: r.rows[0] });
    }

    return res.status(405).json({ success: false, error: "不支持的方法" });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
