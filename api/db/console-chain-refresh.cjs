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

function statusMark(status) {
  if (["success", "completed", "done"].includes(status)) return "✓";
  if (["running", "doing"].includes(status)) return "⏳";
  if (["failed", "blocked", "error"].includes(status)) return "✗";
  if (["waiting", "pending", "queued", "open"].includes(status)) return "…";
  if (status === "skipped") return "-";
  return "";
}

function buildChain(steps) {
  return (steps || [])
    .map((s) => `${s.actor || s.step_name || s.step_type || "unknown"}${statusMark(s.status)}`)
    .join("→");
}

async function loadSteps(client, taskId) {
  const hasRunSteps = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'task_runs'
          AND column_name = 'steps'
     ) AS ok`
  );
  if (hasRunSteps.rows[0].ok) {
    const result = await client.query(
      `SELECT
         COALESCE(step->>'actor', step->>'name', step->>'step_name', step->>'step_type') AS actor,
         COALESCE(step->>'step_name', step->>'name') AS step_name,
         step->>'step_type' AS step_type,
         COALESCE(step->>'status', 'pending') AS status
       FROM task_runs tr
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(tr.steps, '[]'::jsonb)) WITH ORDINALITY AS s(step, ord)
      WHERE tr.task_id = $1
      ORDER BY tr.run_no ASC, tr.started_at ASC, ord ASC`,
      [taskId]
    );
    return result.rows;
  }
  const result = await client.query(
    `SELECT actor, step_name, step_type, status
       FROM task_run_steps
      WHERE task_id = $1
      ORDER BY run_id ASC, step_no ASC, started_at ASC NULLS LAST, created_at ASC`,
    [taskId]
  );
  return result.rows;
}

async function refreshOne(taskId, clientArg) {
  const client = clientArg || await getPool().connect();
  const ownClient = !clientArg;
  try {
    const steps = await loadSteps(client, taskId);
    const chain = buildChain(steps) || null;
    const updated = await client.query(
      `UPDATE tasks
          SET process_chain_cache = $1
        WHERE id = $2
      RETURNING id, process_chain_cache`,
      [chain, taskId]
    );
    if (updated.rowCount === 0) return null;
    return updated.rows[0];
  } finally {
    if (ownClient) client.release();
  }
}

async function refreshAll() {
  const client = await getPool().connect();
  try {
    const tasks = await client.query(
      `SELECT DISTINCT task_id
         FROM task_runs
        WHERE COALESCE(ended_at, started_at, created_at) >= now() - interval '24 hours'
        ORDER BY task_id ASC`
    );
    const rows = [];
    for (const row of tasks.rows) {
      const refreshed = await refreshOne(row.task_id, client);
      if (refreshed) rows.push(refreshed);
    }
    return rows;
  } finally {
    client.release();
  }
}

const router = express.Router();

router.post("/api/console/tasks/:id/refresh-chain", async (req, res) => {
  try {
    const row = await refreshOne(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: "task_not_found" });
    return res.status(200).json({ success: true, data: row });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
module.exports.refreshOne = refreshOne;
module.exports.refreshAll = refreshAll;
module.exports.buildChain = buildChain;
