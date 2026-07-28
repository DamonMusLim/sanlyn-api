// /api/db/hr-staff-checkin.mjs — 集团HRM · 打卡记录（只读镜像）
// 数据源 mini staff_checkin（人脸核验打卡链路，见 checkin_face_* 表），每15分钟单向同步进本表。
// 只读：仅 GET。审批/打卡本身走 mini 现有链路，此处不写。
import { getPool, setCors } from "./db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "只读表，仅支持 GET" });
  }

  const pool = getPool();
  try {
    const { q, face_status, checkin_date, limit = 1000, offset = 0 } = req.query;
    const params = [];
    const conds = [];
    if (face_status) { params.push(face_status); conds.push(`face_status = $${params.length}`); }
    if (checkin_date) { params.push(checkin_date); conds.push(`checkin_date = $${params.length}`); }
    if (q) { params.push(`%${q}%`); conds.push(`staff_name ILIKE $${params.length}`); }

    let sql = "SELECT id, staff_name, employee_id, to_char(checkin_date,'YYYY-MM-DD') AS checkin_date, photo_url, checkin_at, store_code, "
            + "day_wage, note, face_status, face_employee_name, face_score, camera_pic_url, face_error "
            + "FROM hr_staff_checkin";
    if (conds.length) sql += " WHERE " + conds.join(" AND ");
    params.push(Math.min(parseInt(limit) || 1000, 5000));
    sql += ` ORDER BY checkin_date DESC, checkin_at DESC LIMIT $${params.length}`;
    params.push(parseInt(offset) || 0);
    sql += ` OFFSET $${params.length}`;

    const rows = await pool.query(sql, params);
    const c = await pool.query("SELECT COUNT(*) FROM hr_staff_checkin");
    return res.status(200).json({ success: true, data: rows.rows, count: parseInt(c.rows[0].count) });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
