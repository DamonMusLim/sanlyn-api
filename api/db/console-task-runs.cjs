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

function jsonValue(value, fallback) {
  return JSON.stringify(value == null ? fallback : value);
}

async function nextRunNo(client, taskId) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`task-run:${taskId}`]);
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(run_no), 0) + 1 AS run_no
       FROM task_runs
      WHERE task_id = $1`,
    [taskId]
  );
  return rows[0].run_no;
}

async function nextStepNo(client, runId) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`task-step:${runId}`]);
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(step_no), 0) + 1 AS step_no
       FROM task_run_steps
      WHERE run_id = $1`,
    [runId]
  );
  return rows[0].step_no;
}

const router = express.Router();

router.post("/api/console/runs", async (req, res) => {
  const client = await getPool().connect();
  try {
    const body = req.body || {};
    if (!body.task_id) return res.status(400).json({ success: false, error: "task_id required" });

    await client.query("BEGIN");
    const runNo = await nextRunNo(client, body.task_id);
    const inserted = await client.query(
      `INSERT INTO task_runs (
         task_id, run_no, triggered_by, trigger_type, status,
         input_snapshot, cost_summary
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)
       RETURNING *`,
      [
        body.task_id,
        runNo,
        body.triggered_by || "system",
        body.trigger_type || "manual",
        body.status || "running",
        jsonValue(body.input_snapshot, {}),
        jsonValue(body.cost_summary, {}),
      ]
    );
    await client.query("COMMIT");
    return res.status(200).json({ success: true, data: inserted.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

router.post("/api/console/runs/:id/steps", async (req, res) => {
  const client = await getPool().connect();
  try {
    const body = req.body || {};
    if (!body.actor) return res.status(400).json({ success: false, error: "actor required" });
    if (!body.step_type) return res.status(400).json({ success: false, error: "step_type required" });

    await client.query("BEGIN");
    const run = await client.query(
      `SELECT id, task_id
         FROM task_runs
        WHERE id = $1
        FOR UPDATE`,
      [req.params.id]
    );
    if (run.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, error: "run_not_found" });
    }

    const stepNo = body.step_no || await nextStepNo(client, req.params.id);
    const inserted = await client.query(
      `INSERT INTO task_run_steps (
         task_id, run_id, step_no, step_key, step_name, actor, actor_type,
         step_type, tool_name, model_name, input_summary, output_summary,
         status, failure_point, failure_reason_code, failure_reason_detail,
         input_refs, input_payload, input_quality, output_refs, output_payload,
         hermes_request_id, hermes_response_id, hermes_payload, retry_count,
         token_cost, started_at, ended_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
         $17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb,$21::jsonb,
         $22,$23,$24::jsonb,$25,$26,$27,$28
       )
       RETURNING *`,
      [
        run.rows[0].task_id,
        req.params.id,
        stepNo,
        body.step_key || null,
        body.step_name || null,
        body.actor,
        body.actor_type || null,
        body.step_type,
        body.tool_name || null,
        body.model_name || null,
        body.input_summary || null,
        body.output_summary || null,
        body.status || "success",
        body.failure_point || null,
        body.failure_reason_code || null,
        body.failure_reason_detail || null,
        jsonValue(body.input_refs, []),
        jsonValue(body.input_payload, {}),
        jsonValue(body.input_quality, {}),
        jsonValue(body.output_refs, []),
        jsonValue(body.output_payload, {}),
        body.hermes_request_id || null,
        body.hermes_response_id || null,
        jsonValue(body.hermes_payload, {}),
        parseInt(body.retry_count || "0", 10),
        body.token_cost || 0,
        body.started_at || null,
        body.ended_at || null,
      ]
    );

    const step = inserted.rows[0];
    if (["failed", "blocked"].includes(step.status)) {
      await client.query(
        `UPDATE task_runs
            SET status = $1,
                failure_step_id = $2,
                failure_point = $3,
                failure_reason_code = $4,
                failure_reason_detail = $5
          WHERE id = $6`,
        [
          step.status,
          step.id,
          step.failure_point,
          step.failure_reason_code,
          step.failure_reason_detail,
          req.params.id,
        ]
      );
      await client.query(
        `UPDATE tasks
            SET failure_point = $1
          WHERE id = $2`,
        [step.failure_point, step.task_id]
      );
    }

    await client.query("COMMIT");
    return res.status(200).json({ success: true, data: step });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

router.patch("/api/console/runs/:id", async (req, res) => {
  try {
    const body = req.body || {};
    const updated = await getPool().query(
      `UPDATE task_runs
          SET status = COALESCE($1, status),
              failure_point = COALESCE($2, failure_point),
              failure_reason_code = COALESCE($3, failure_reason_code),
              failure_reason_detail = COALESCE($4, failure_reason_detail),
              output_snapshot = COALESCE($5::jsonb, output_snapshot),
              cost_summary = COALESCE($6::jsonb, cost_summary),
              ended_at = COALESCE($7, ended_at, CASE WHEN $1 IN ('success','failed','blocked','cancelled') THEN now() END)
        WHERE id = $8
      RETURNING *`,
      [
        body.status || null,
        body.failure_point || null,
        body.failure_reason_code || null,
        body.failure_reason_detail || null,
        body.output_snapshot == null ? null : jsonValue(body.output_snapshot, {}),
        body.cost_summary == null ? null : jsonValue(body.cost_summary, {}),
        body.ended_at || null,
        req.params.id,
      ]
    );
    if (updated.rowCount === 0) return res.status(404).json({ success: false, error: "run_not_found" });
    const run = updated.rows[0];
    if (["failed", "blocked"].includes(run.status)) {
      await getPool().query(
        `UPDATE tasks
            SET failure_point = $1
          WHERE id = $2`,
        [run.failure_point, run.task_id]
      );
    }
    return res.status(200).json({ success: true, data: run });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/api/console/tasks/:taskId/chain", async (req, res) => {
  try {
    const task = await getPool().query(
      `SELECT id, task_code, status, domain, level, escalation_count, failure_point, input_refs
         FROM tasks
        WHERE id = $1`,
      [req.params.taskId]
    );
    if (task.rowCount === 0) return res.status(404).json({ success: false, error: "task_not_found" });

    const runs = await getPool().query(
      `SELECT *
         FROM task_runs
        WHERE task_id = $1
        ORDER BY run_no ASC, started_at ASC`,
      [req.params.taskId]
    );
    const steps = await getPool().query(
      `SELECT *
         FROM task_run_steps
        WHERE task_id = $1
        ORDER BY run_id ASC, step_no ASC, started_at ASC NULLS LAST, created_at ASC`,
      [req.params.taskId]
    );
    return res.status(200).json({
      success: true,
      data: { task: task.rows[0], runs: runs.rows, steps: steps.rows },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
