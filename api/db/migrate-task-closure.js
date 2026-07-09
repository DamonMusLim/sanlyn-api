import { getPool, setCors } from "../db.js";

const ACTIVE_STATUS_PREDICATE = "status NOT IN ('done', 'cancelled')";

const STATEMENTS = [
  `ALTER TABLE tasks
     ADD COLUMN IF NOT EXISTS source VARCHAR,
     ADD COLUMN IF NOT EXISTS dedupe_key VARCHAR,
     ADD COLUMN IF NOT EXISTS priority VARCHAR(4),
     ADD COLUMN IF NOT EXISTS owner_user_id VARCHAR,
     ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS notify_stage INT DEFAULT 0,
     ADD COLUMN IF NOT EXISTS next_notify_at TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS last_notified_at TIMESTAMPTZ`,

  `CREATE TABLE IF NOT EXISTS task_events (
     id BIGSERIAL PRIMARY KEY,
     task_id VARCHAR REFERENCES tasks(id),
     event_type VARCHAR NOT NULL,
     actor_type VARCHAR,
     actor_id VARCHAR,
     from_status VARCHAR,
     to_status VARCHAR,
     note TEXT,
     metadata JSONB,
     created_at TIMESTAMPTZ DEFAULT NOW()
   )`,

  `CREATE INDEX IF NOT EXISTS idx_task_events_task_created
     ON task_events(task_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS task_push_attempts (
     id BIGSERIAL PRIMARY KEY,
     task_id VARCHAR,
     idempotency_key VARCHAR UNIQUE,
     stage INT,
     channel VARCHAR,
     status VARCHAR,
     error TEXT,
     created_at TIMESTAMPTZ DEFAULT NOW()
   )`,
];

async function findActiveDedupeConflicts(pool) {
  return pool.query(
    `SELECT source,
            dedupe_key,
            COUNT(*)::int AS active_count,
            ARRAY_AGG(id ORDER BY created_at DESC, id DESC) AS task_ids
       FROM tasks
      WHERE source IS NOT NULL
        AND dedupe_key IS NOT NULL
        AND ${ACTIVE_STATUS_PREDICATE}
      GROUP BY source, dedupe_key
     HAVING COUNT(*) > 1
      ORDER BY active_count DESC, source, dedupe_key
      LIMIT 50`
  );
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "POST only" });
  }

  const pool = getPool();
  const log = [];

  try {
    for (const sql of STATEMENTS) {
      await pool.query(sql);
      log.push("OK: " + sql.replace(/\s+/g, " ").trim().slice(0, 110));
    }

    const conflicts = await findActiveDedupeConflicts(pool);
    if (conflicts.rowCount > 0) {
      return res.status(409).json({
        success: false,
        error: "active dedupe conflicts must be resolved before creating ux_tasks_open_dedupe",
        rule: "same (source,dedupe_key) may have only one task where status NOT IN ('done','cancelled')",
        action: "人工确认后把多余活跃任务改为 done/cancelled，或清空其 source/dedupe_key；迁移可重复 POST",
        conflicts: conflicts.rows,
        log,
      });
    }

    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_tasks_open_dedupe
         ON tasks(source, dedupe_key)
       WHERE ${ACTIVE_STATUS_PREDICATE}`
    );
    log.push("OK: CREATE UNIQUE INDEX IF NOT EXISTS ux_tasks_open_dedupe");

    return res.status(200).json({
      success: true,
      status_model: "reuse tasks.status=open|doing|done|cancelled; closure substatus/resolution detail stays in tasks.raw",
      columns_added: [
        "source",
        "dedupe_key",
        "priority",
        "owner_user_id",
        "acknowledged_at",
        "resolved_at",
        "notify_stage",
        "next_notify_at",
        "last_notified_at",
      ],
      indexes_added: ["ux_tasks_open_dedupe", "idx_task_events_task_created"],
      tables_ready: ["task_events", "task_push_attempts"],
      log,
    });
  } catch (err) {
    console.error("[migrate-task-closure]", err);
    return res.status(500).json({ success: false, error: String(err.message || err), log });
  }
}
