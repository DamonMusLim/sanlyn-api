// /api/db/staff-daily-reports.mjs — 店员每日工作汇报/日记 主表 CRUD
// 独立模块 · 门店域临时借放在海运 Admin，以后整体迁出（只动这一个文件 + mount 一行）。
import { getPool, setCors } from "./db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();

  if (req.method === "GET") {
    try {
      const { action, date, staff_name, report_date, store_name, from, to, limit = 500 } = req.query;
      if (action === "day-counts") {
        const params = [];
        const conds = [];
        if (from) { params.push(from); conds.push(`report_date >= $${params.length}`); }
        if (to) { params.push(to); conds.push(`report_date <= $${params.length}`); }
        let q = `
          SELECT
            report_date::text AS report_date,
            count(*)::int AS count,
            count(*) FILTER (WHERE jsonb_array_length(COALESCE(issues, '[]'::jsonb)) > 0)::int AS issue_count
          FROM staff_daily_reports`;
        if (conds.length) q += " WHERE " + conds.join(" AND ");
        q += " GROUP BY report_date ORDER BY report_date DESC";
        const r = await pool.query(q, params);
        return res.status(200).json({ success: true, data: r.rows, count: r.rowCount });
      }
      if (action === "month-counts") {
        const r = await pool.query(`
          SELECT to_char(report_date, 'YYYY-MM') AS month, count(*)::int AS count
          FROM staff_daily_reports
          GROUP BY 1
          ORDER BY 1 DESC
        `);
        return res.status(200).json({ success: true, data: r.rows, count: r.rowCount });
      }

      if (action === "missing-report") {
        const targetDate = date || report_date || new Date().toISOString().slice(0, 10);
        const r = await pool.query(
          `WITH active AS (
             SELECT staff_name, COALESCE(store_name, '') AS store_key,
                    NULLIF(store_name, '') AS store_name,
                    max(report_date)::text AS last_seen_date
             FROM staff_daily_reports
             WHERE report_date >= ($1::date - interval '7 days')
               AND report_date < $1::date
               AND COALESCE(staff_name, '') <> ''
             GROUP BY staff_name, COALESCE(store_name, ''), NULLIF(store_name, '')
           )
           SELECT a.staff_name, a.store_name, a.last_seen_date
           FROM active a
           WHERE NOT EXISTS (
             SELECT 1 FROM staff_daily_reports s
             WHERE s.report_date = $1::date
               AND s.staff_name = a.staff_name
               AND COALESCE(s.store_name, '') = a.store_key
           )
           ORDER BY a.store_name NULLS LAST, a.staff_name`,
          [targetDate]
        );
        return res.status(200).json({ success: true, data: r.rows, count: r.rowCount });
      }

      if (action === "source-health") {
        const targetDate = date || report_date || new Date().toISOString().slice(0, 10);
        const r = await pool.query(
          `SELECT data_source,
                  CASE
                    WHEN module_fail > 0 THEN 'critical'
                    WHEN abnormal > 0 THEN 'degraded'
                    WHEN none > 0 THEN 'partial'
                    ELSE 'ok'
                  END AS health,
                  total, have, none, abnormal, module_fail
           FROM (
             SELECT COALESCE(NULLIF(data_source, ''), '(未填数据源)') AS data_source,
                    count(*)::int AS total,
                    count(*) FILTER (WHERE result_state = 'have')::int AS have,
                    count(*) FILTER (WHERE result_state = 'none')::int AS none,
                    count(*) FILTER (WHERE result_state = 'abnormal')::int AS abnormal,
                    count(*) FILTER (WHERE result_state = 'module_fail')::int AS module_fail
             FROM staff_daily_reports
             WHERE report_date = $1::date
             GROUP BY 1
           ) x
           ORDER BY
             CASE
               WHEN module_fail > 0 THEN 1
               WHEN abnormal > 0 THEN 2
               WHEN none > 0 THEN 3
               ELSE 4
             END,
             data_source`,
          [targetDate]
        );
        return res.status(200).json({ success: true, data: r.rows, count: r.rowCount });
      }

      let q = `
        SELECT s.id, s.report_date::text AS report_date, s.staff_name, s.store_name, s.product,
               s.work_report, s.diary, s.data_source, s.result_state, s.report_to, s.fail_reason,
               s.issues, s.evidence_event_ids, s.checkin_at, s.created_at, s.updated_at,
               pt.status AS problem_status, pt.task_id AS problem_task_ref, pt.updated_at AS problem_updated_at
        FROM staff_daily_reports s
        LEFT JOIN problem_tasks pt ON pt.id = s.problem_task_id`, params = [], conds = [];
      if (staff_name)  { params.push(staff_name);  conds.push(`s.staff_name = $${params.length}`); }
      if (report_date) { params.push(report_date); conds.push(`s.report_date = $${params.length}`); }
      if (store_name)  { params.push(store_name);  conds.push(`s.store_name = $${params.length}`); }
      if (conds.length) q += " WHERE " + conds.join(" AND ");
      params.push(Math.min(parseInt(limit, 10) || 500, 2000));
      q += ` ORDER BY s.report_date DESC, s.created_at DESC LIMIT $${params.length}`;
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
           (report_date, staff_name, store_name, product, work_report, diary,
            data_source, result_state, report_to, fail_reason, issues, evidence_event_ids, checkin_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [
          b.report_date || new Date().toISOString().slice(0, 10),
          b.staff_name,
          b.store_name || null,
          b.product || null,
          b.work_report || null,
          b.diary || null,
          b.data_source || null,
          b.result_state || null,
          b.report_to || null,
          b.fail_reason || null,
          b.issues === undefined ? JSON.stringify([]) : (Array.isArray(b.issues) ? JSON.stringify(b.issues) : b.issues),
          b.evidence_event_ids === undefined ? JSON.stringify([]) : (Array.isArray(b.evidence_event_ids) ? JSON.stringify(b.evidence_event_ids) : b.evidence_event_ids),
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
      const allowed = [
        "report_date", "staff_name", "store_name", "product", "work_report", "diary",
        "data_source", "result_state", "report_to", "fail_reason", "issues", "evidence_event_ids", "checkin_at",
      ];
      const sets = [], vals = [];
      for (const k of allowed) {
        if (patch[k] !== undefined) {
          vals.push(Array.isArray(patch[k]) ? JSON.stringify(patch[k]) : patch[k]);
          sets.push(`${k} = $${vals.length}`);
        }
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
