// /api/db/staff-daily-reports.mjs — 店员每日工作汇报/日记 主表 CRUD
// 独立模块 · 门店域临时借放在海运 Admin，以后整体迁出（只动这一个文件 + mount 一行）。
import { getPool, setCors } from "./db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();

  if (req.method === "GET") {
    try {
      const { staff_name, report_date, store_name, limit = 500 } = req.query;
      let q = "SELECT id, report_date::text AS report_date, staff_name, store_name, product, work_report, diary, checkin_at, created_at, updated_at FROM staff_daily_reports", params = [], conds = [];
      if (staff_name)  { params.push(staff_name);  conds.push(`staff_name = $${params.length}`); }
      if (report_date) { params.push(report_date); conds.push(`report_date = $${params.length}`); }
      if (store_name)  { params.push(store_name);  conds.push(`store_name = $${params.length}`); }
      if (conds.length) q += " WHERE " + conds.join(" AND ");
      params.push(parseInt(limit));
      q += ` ORDER BY report_date DESC, created_at DESC LIMIT $${params.length}`;
      const r = await pool.query(q, params);
      return res.status(200).json({ success: true, data: r.rows, count: r.rowCount });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (req.method === "POST") {
    try {
      const b = req.body || {};
      if (!b.staff_name) return res.status(400).json({ error: "staff_name required（填报人必填）" });
      const r = await pool.query(
        `INSERT INTO staff_daily_reports
           (report_date, staff_name, store_name, product, work_report, diary, checkin_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          b.report_date || new Date().toISOString().slice(0, 10),
          b.staff_name,
          b.store_name || null,
          b.product || null,
          b.work_report || null,
          b.diary || null,
          b.checkin_at || new Date().toISOString(),
        ]
      );
      return res.status(201).json({ success: true, data: r.rows[0] });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (req.method === "PATCH") {
    try {
      const { id, ...patch } = req.body || {};
      if (!id) return res.status(400).json({ error: "id required" });
      const allowed = ["report_date", "staff_name", "store_name", "product", "work_report", "diary", "checkin_at"];
      const sets = [], vals = [];
      for (const k of allowed) {
        if (patch[k] !== undefined) { vals.push(patch[k]); sets.push(`${k} = $${vals.length}`); }
      }
      if (!sets.length) return res.status(400).json({ error: "no fields to update" });
      vals.push(id);
      const r = await pool.query(
        `UPDATE staff_daily_reports SET ${sets.join(", ")}, updated_at = now() WHERE id = $${vals.length} RETURNING *`,
        vals
      );
      if (!r.rowCount) return res.status(404).json({ error: "report not found" });
      return res.status(200).json({ success: true, data: r.rows[0] });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (req.method === "DELETE") {
    try {
      const id = req.query.id || req.body?.id;
      if (!id) return res.status(400).json({ error: "id required" });
      const r = await pool.query("DELETE FROM staff_daily_reports WHERE id = $1", [id]);
      if (!r.rowCount) return res.status(404).json({ error: "report not found" });
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
