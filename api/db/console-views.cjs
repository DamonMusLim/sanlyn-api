"use strict";

const express = require("express");
const { Pool } = require("pg");

let pool;

function getPool() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: parseInt(process.env.PG_POOL_MAX || "3", 10),
    });
  }
  return pool;
}

function cleanText(value) {
  const text = String(value || "").trim();
  return text || null;
}

function cleanLimit(value) {
  const parsed = parseInt(value || "200", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 200;
  return Math.min(parsed, 500);
}

const router = express.Router();

router.get("/api/console/tasks", async (req, res) => {
  try {
    const status = cleanText(req.query.status);
    const prefix = cleanText(req.query.prefix || req.query.domain);
    const q = cleanText(req.query.q);
    const includeDone = cleanText(req.query.include_done) === "1" || status === "done";
    const limit = cleanLimit(req.query.limit);
    const result = await getPool().query(
      `SELECT id, display_task_code, serial_no, task_prefix, domain_label,
              title, detail, status, level, progress_pct, progress_label, result_summary,
              current_holder, current_holder_role, next_holder, relay_path, risk_color,
              chase_count, failure_point, related_biz_no, next_action, ai_suggestion,
              created_at, updated_at
         FROM task_center_v
        WHERE ($1::text IS NULL OR status = $1)
          AND ($2::text IS NULL OR task_prefix = $2)
          AND ($3::boolean OR COALESCE(status, '') <> 'done')
          AND (
            $4::text IS NULL
            OR display_task_code ILIKE '%' || $4 || '%'
            OR related_biz_no ILIKE '%' || $4 || '%'
            OR id::text ILIKE '%' || $4 || '%'
            OR title ILIKE '%' || $4 || '%'
          )
        ORDER BY (risk_color='red') DESC, updated_at DESC 
        LIMIT $5`,
      [status, prefix, includeDone, q, limit]
    );
    return res.status(200).json({ success: true, count: result.rowCount, data: result.rows });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/api/console/domain-counts", async (req, res) => {
  try {
    const result = await getPool().query(
      `SELECT
         COALESCE(task_prefix, 'UNKNOWN') AS task_prefix,
         COALESCE(domain_label, '未知') AS domain_label,
         COUNT(*)::int AS total_count,
         COUNT(*) FILTER (
           WHERE status = 'doing'
             AND (NULLIF(failure_point, '') IS NOT NULL OR updated_at < now() - interval '48 hours')
         )::int AS stuck_count,
         COUNT(*) FILTER (WHERE level = 'L4' AND status = 'open')::int AS decision_count
       FROM task_center_v
      GROUP BY task_prefix, domain_label
      ORDER BY
        CASE COALESCE(task_prefix, 'UNKNOWN')
          WHEN 'FS' THEN 1 WHEN 'CY' THEN 2 WHEN 'CAW' THEN 3
          WHEN 'FIN' THEN 4 WHEN 'OPS' THEN 5 WHEN 'D' THEN 6 ELSE 9
        END,
        task_prefix ASC`
    );
    try {
      const oc = await getPool().query("SELECT COUNT(*)::int AS c FROM task_center_v WHERE current_holder = 'Ocean' AND status <> 'done'");
      result.rows.push({ task_prefix: '__OCEAN__', domain_label: 'Ocean代码', total_count: oc.rows[0].c, stuck_count: 0, decision_count: 0 });
    } catch (e) { /* ocean count optional */ }
    return res.status(200).json({ success: true, count: result.rows.length, data: result.rows });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/api/console/tasks-summary", async (req, res) => {
  try {
    const result = await getPool().query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'open')::int AS open,
         COUNT(*) FILTER (WHERE status = 'doing')::int AS doing,
         COUNT(*) FILTER (
           WHERE status = 'done'
             AND updated_at >= (((now() AT TIME ZONE 'Asia/Shanghai')::date)::timestamp AT TIME ZONE 'Asia/Shanghai')
             AND updated_at < ((((now() AT TIME ZONE 'Asia/Shanghai')::date + 1))::timestamp AT TIME ZONE 'Asia/Shanghai')
         )::int AS done_today,
         COUNT(*) FILTER (
           WHERE status = 'doing'
             AND (updated_at < now() - interval '48 hours' OR NULLIF(failure_point, '') IS NOT NULL)
         )::int AS stuck,
         COUNT(*) FILTER (
           WHERE created_at >= (((now() AT TIME ZONE 'Asia/Shanghai')::date)::timestamp AT TIME ZONE 'Asia/Shanghai')
             AND created_at < ((((now() AT TIME ZONE 'Asia/Shanghai')::date + 1))::timestamp AT TIME ZONE 'Asia/Shanghai')
         )::int AS today_new
       FROM tasks`
    );
    return res.status(200).json({ success: true, ...result.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/api/console/staff", async (req, res) => {
  try {
    const result = await getPool().query(
      `SELECT staff_no, name_cn, name_en, skill_keys, domain, duty, status,
              escalates_to, heartbeat_at, today_note, seat_no
         FROM ai_staff
        ORDER BY seat_no NULLS LAST, staff_no ASC`
    );
    return res.status(200).json({ success: true, count: result.rowCount, data: result.rows });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/api/console/push-log-summary", async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || "7", 10) || 7, 1), 60);
    const result = await getPool().query(
      `SELECT (pushed_at AT TIME ZONE 'Asia/Shanghai')::date AS day,
              audience,
              COUNT(*)::int AS count
         FROM push_log
        WHERE pushed_at >= now() - ($1::int * interval '1 day')
        GROUP BY day, audience
        ORDER BY day DESC, audience ASC`,
      [days]
    );
    return res.status(200).json({ success: true, days, data: result.rows });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
