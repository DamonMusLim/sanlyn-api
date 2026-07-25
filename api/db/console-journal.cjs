"use strict";

const express = require("express");
const { Pool } = require("pg");

let pool;
function getPool() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL, max: parseInt(process.env.PG_POOL_MAX || "3", 10) });
  return pool;
}

const router = express.Router();
router.use(express.json({ limit: "8mb" }));

const cleanText = (v) => {
  const s = String(v ?? "").trim();
  return s || null;
};
const cleanDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);
const cleanRating = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
};
const cleanAttachments = (v) => Array.isArray(v) ? v : [];
const ok = (res, body) => res.status(200).json({ success: true, ...body });
const fail = (res, err) => res.status(500).json({ success: false, error: err.message || String(err) });

async function insertTaskEvent(client, payload) {
  const cols = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'task_events'`
  );
  if (!cols.rowCount) return;
  const have = new Set(cols.rows.map((r) => r.column_name));
  const map = {
    task_id: payload.task_id,
    event_type: "JOURNAL_ACTION",
    from_status: payload.from_status,
    to_status: payload.to_status,
    actor_type: payload.actor_type,
    actor_id: payload.actor_id,
    note: payload.note,
    journal_id: payload.journal_id,
  };
  const names = Object.keys(map).filter((k) => have.has(k));
  if (!names.length) return;
  const sql = `INSERT INTO task_events (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`;
  await client.query(sql, names.map((k) => map[k]));
}

router.get("/api/console/tasks", async (req, res) => {
  try {
    const status = cleanText(req.query.status);
    const prefix = cleanText(req.query.prefix || req.query.domain);
    const q = cleanText(req.query.q);
    const includeDone = cleanText(req.query.include_done) === "1" || status === "done";
    const limit = Math.min(Math.max(parseInt(req.query.limit || "200", 10) || 200, 1), 500);
    const result = await getPool().query(
      `SELECT id, display_task_code, task_code, legacy_task_code, task_code_v2,
              task_prefix, domain_label, domain, related_biz_no, title, status,
              mode, priority, level, escalation_count, failure_point, assigned_to,
              assigned_staff_no, staff_name, skill_owner_label, process_chain_cache,
              ai_suggestion, next_action, reason, created_at, updated_at,
              serial_no, progress_pct, progress_label, result_summary
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
        ORDER BY
          CASE level WHEN 'L4' THEN 1 WHEN 'L3' THEN 2 WHEN 'L2' THEN 3 WHEN 'L1' THEN 4 ELSE 5 END,
          updated_at DESC NULLS LAST,
          id DESC
        LIMIT $5`,
      [status, prefix, includeDone, q, limit]
    );
    ok(res, { count: result.rowCount, data: result.rows });
  } catch (err) { fail(res, err); }
});

router.get("/api/console/tasks/:id/journal", async (req, res) => {
  try {
    const result = await getPool().query(
      `SELECT task_id, entry_date, entry_count, progress_summary, next_plan_summary,
              issue_summary, has_unblock, latest_status_change_to, entries,
              attachments, first_created_at, last_created_at
         FROM task_journal_by_day
        WHERE task_id = $1
        ORDER BY entry_date DESC, last_created_at DESC`,
      [req.params.id]
    );
    ok(res, { count: result.rowCount, data: result.rows });
  } catch (err) { fail(res, err); }
});

router.post("/api/console/tasks/:id/journal", async (req, res) => {
  const client = await getPool().connect();
  try {
    const body = req.body || {};
    const authorType = cleanText(body.author_type);
    if (!["clerk", "agent", "damon", "manager"].includes(authorType)) throw new Error("author_type invalid");
    const progress = cleanText(body.progress);
    if (!progress) throw new Error("progress required");
    const actionTaken = cleanText(body.action_taken);
    const mayDrive = ["damon", "manager"].includes(authorType) && actionTaken;
    if (actionTaken && !mayDrive) throw new Error("only damon/manager can action_taken");

    await client.query("BEGIN");
    const current = await client.query("SELECT id, status FROM tasks WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (!current.rowCount) throw new Error("task not found");
    const fromStatus = current.rows[0].status || null;
    const statusTo = mayDrive ? cleanText(body.status_change_to) : null;
    const resultSummary = mayDrive ? (cleanText(body.result_summary) || progress) : null;
    const inserted = await client.query(
      `INSERT INTO task_journal (
         task_id, entry_date, author_type, author_id, progress, next_plan, issue,
         attachments, action_taken, unblocks, status_change_to, entry_type,
         source, can_drive_task, drive_action, unblocks_step_key, payload
       ) VALUES (
         $1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5, $6, $7,
         $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb
       )
       RETURNING *`,
      [
        req.params.id,
        cleanDate(body.entry_date),
        authorType,
        cleanText(body.author_id),
        progress,
        cleanText(body.next_plan),
        cleanText(body.issue),
        JSON.stringify(cleanAttachments(body.attachments)),
        actionTaken,
        Boolean(mayDrive && (body.unblocks ?? true)),
        statusTo,
        mayDrive ? "unblock" : "progress",
        authorType === "agent" ? "auto" : "manual",
        Boolean(mayDrive),
        mayDrive ? (cleanText(body.drive_action) || "change_status") : null,
        mayDrive ? cleanText(body.unblocks_step_key) : null,
        JSON.stringify(body.payload && typeof body.payload === "object" ? body.payload : {}),
      ]
    );
    const journal = inserted.rows[0];
    if (mayDrive) {
      await client.query(
        `UPDATE tasks
            SET status = COALESCE($2, status),
                result_summary = COALESCE($3, result_summary),
                updated_at = COALESCE(now(), updated_at)
          WHERE id = $1`,
        [req.params.id, statusTo, resultSummary]
      );
      await insertTaskEvent(client, {
        task_id: req.params.id,
        from_status: fromStatus,
        to_status: statusTo,
        actor_type: authorType,
        actor_id: cleanText(body.author_id),
        note: actionTaken,
        journal_id: journal.id,
      });
      await client.query(
        `INSERT INTO task_journal_events (task_id, journal_id, event_type, target_agent)
         VALUES ($1, $2, $3, $4)`,
        [req.params.id, journal.id, "journal_drive_action_created", cleanText(body.target_agent)]
      );
    }
    await client.query("COMMIT");
    ok(res, { data: journal });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(400).json({ success: false, error: err.message || String(err) });
  } finally { client.release(); }
});

router.get("/api/console/journal/unfilled", async (req, res) => {
  try {
    const date = cleanDate(req.query.date) || new Date().toISOString().slice(0, 10);
    const result = await getPool().query(
      `SELECT t.id AS task_id, COALESCE(t.task_code_v2, t.task_code) AS task_code,
              t.title, t.status, t.assigned_staff_no,
              COALESCE(to_jsonb(s)->>'name_cn', to_jsonb(s)->>'name', to_jsonb(s)->>'name_en') AS staff_name,
              $1::date AS entry_date
         FROM tasks t
         LEFT JOIN ai_staff s ON s.staff_no = t.assigned_staff_no
        WHERE t.assigned_staff_no IS NOT NULL
          AND COALESCE(t.status, '') IN ('open', 'doing')
          AND NOT EXISTS (
            SELECT 1 FROM task_journal j
             WHERE j.task_id = t.id AND j.entry_date = $1::date
               AND j.author_id = t.assigned_staff_no
          )
        ORDER BY t.assigned_staff_no, task_code`,
      [date]
    );
    ok(res, { date, count: result.rowCount, data: result.rows });
  } catch (err) { fail(res, err); }
});

router.get("/api/console/staff-journal", async (req, res) => {
  try {
    const date = cleanDate(req.query.date) || new Date().toISOString().slice(0, 10);
    const result = await getPool().query(
      `SELECT s.staff_no,
              COALESCE(to_jsonb(s)->>'name_cn', to_jsonb(s)->>'name', to_jsonb(s)->>'name_en') AS staff_name,
              s.domain, s.duty, j.entry_date, j.summary, j.auto_generated,
              j.damon_rating, j.damon_comment, j.created_at, j.updated_at
         FROM ai_staff s
         LEFT JOIN staff_journal j ON j.staff_no = s.staff_no AND j.entry_date = $1::date
        ORDER BY s.staff_no`,
      [date]
    );
    ok(res, { date, count: result.rowCount, data: result.rows });
  } catch (err) { fail(res, err); }
});

router.get("/api/console/staff/:no/journal", async (req, res) => {
  try {
    const result = await getPool().query(
      `SELECT id, staff_no, entry_date, summary, auto_generated,
              damon_rating, damon_comment, created_at, updated_at
         FROM staff_journal
        WHERE staff_no = $1
        ORDER BY entry_date DESC
        LIMIT 60`,
      [req.params.no]
    );
    ok(res, { count: result.rowCount, data: result.rows });
  } catch (err) { fail(res, err); }
});

router.post("/api/console/staff/:no/journal", async (req, res) => {
  try {
    const body = req.body || {};
    const date = cleanDate(body.entry_date) || new Date().toISOString().slice(0, 10);
    const rating = cleanRating(body.rating ?? body.damon_rating);
    const comment = cleanText(body.comment ?? body.damon_comment);
    const summary = cleanText(body.summary);
    if (!rating && !comment && !summary) throw new Error("rating/comment/summary required");
    const result = await getPool().query(
      `INSERT INTO staff_journal (staff_no, entry_date, summary, auto_generated, damon_rating, damon_comment)
       VALUES ($1, $2::date, $3, $4, $5, $6)
       ON CONFLICT (staff_no, entry_date) DO UPDATE SET
         summary = COALESCE(EXCLUDED.summary, staff_journal.summary),
         auto_generated = staff_journal.auto_generated OR EXCLUDED.auto_generated,
         damon_rating = COALESCE(EXCLUDED.damon_rating, staff_journal.damon_rating),
         damon_comment = COALESCE(EXCLUDED.damon_comment, staff_journal.damon_comment),
         updated_at = now()
       RETURNING *`,
      [req.params.no, date, summary, Boolean(body.auto_generated), rating, comment]
    );
    ok(res, { data: result.rows[0] });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message || String(err) });
  }
});

module.exports = router;
