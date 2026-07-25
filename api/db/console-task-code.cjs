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

function pickPrefix(domain) {
  const raw = String(domain || "").trim().toLowerCase();
  if (raw.includes("petshop") || raw.includes("pet") || raw.includes("caw") || raw.includes("宠物")) {
    return "CAW";
  }
  if (
    raw.includes("ocean") ||
    raw.includes("海运") ||
    raw.includes("freight") ||
    raw.includes("customs") ||
    raw.includes("shipping")
  ) {
    return "OB";
  }
  return "D";
}

function shanghaiMinute(d) {
  const date = d ? new Date(d) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error("invalid_created_at");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}`;
}

function nextCodeFromRows(prefix, minute, rows) {
  const base = `${prefix}${minute}`;
  let maxSeq = 0;
  for (const row of rows) {
    const code = row.task_code;
    if (code === base) {
      maxSeq = Math.max(maxSeq, 1);
      continue;
    }
    const m = String(code || "").match(new RegExp(`^${base}-(\\d{2})$`));
    if (m) maxSeq = Math.max(maxSeq, parseInt(m[1], 10));
  }
  if (maxSeq === 0) return base;
  if (maxSeq >= 99) throw new Error("task_code_minute_exhausted");
  return `${base}-${String(maxSeq + 1).padStart(2, "0")}`;
}

async function generateTaskCodeInTx(client, domain, createdAt) {
  const prefix = pickPrefix(domain);
  const minute = shanghaiMinute(createdAt);
  const base = `${prefix}${minute}`;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [base]);
  const { rows } = await client.query(
    `SELECT task_code
       FROM tasks
      WHERE task_code = $1 OR task_code LIKE $2
      FOR UPDATE`,
    [base, `${base}-%`]
  );
  return nextCodeFromRows(prefix, minute, rows);
}

async function assignTaskCode(client, taskId, domain, createdAt) {
  const existing = await client.query(
    `SELECT id, task_code, domain, created_at
       FROM tasks
      WHERE id = $1
      FOR UPDATE`,
    [taskId]
  );
  if (existing.rowCount === 0) throw new Error("task_not_found");
  const task = existing.rows[0];
  if (task.task_code) return { task_id: task.id, task_code: task.task_code, existed: true };

  for (let i = 0; i < 5; i += 1) {
    const code = await generateTaskCodeInTx(client, domain || task.domain, createdAt || task.created_at);
    try {
      const updated = await client.query(
        `UPDATE tasks
            SET task_code = $1
          WHERE id = $2 AND task_code IS NULL
        RETURNING id, task_code`,
        [code, taskId]
      );
      if (updated.rowCount === 1) {
        return { task_id: updated.rows[0].id, task_code: updated.rows[0].task_code, existed: false };
      }
    } catch (err) {
      if (err.code !== "23505") throw err;
    }
  }
  throw new Error("task_code_conflict_retry_exhausted");
}

async function backfillTaskCodes(limit) {
  const client = await getPool().connect();
  const updated = [];
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT id, domain, created_at
         FROM tasks
        WHERE task_code IS NULL
        ORDER BY created_at ASC NULLS LAST, id ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [Math.min(parseInt(limit || "200", 10), 1000)]
    );
    for (const task of rows) {
      const result = await assignTaskCode(client, task.id, task.domain, task.created_at);
      updated.push(result);
    }
    await client.query("COMMIT");
    return updated;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function genTaskCode(domain, options) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const code = await generateTaskCodeInTx(client, domain, options && options.created_at);
    await client.query("COMMIT");
    return code;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

const router = express.Router();

router.post("/api/console/task-code/gen", async (req, res) => {
  const client = await getPool().connect();
  try {
    const { task_id, domain, created_at } = req.body || {};
    await client.query("BEGIN");
    let data;
    if (task_id) {
      data = await assignTaskCode(client, task_id, domain, created_at);
    } else {
      data = { task_code: await generateTaskCodeInTx(client, domain, created_at), persisted: false };
    }
    await client.query("COMMIT");
    return res.status(200).json({ success: true, data });
  } catch (err) {
    await client.query("ROLLBACK");
    const status = err.message === "task_not_found" ? 404 : 500;
    return res.status(status).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

router.post("/api/console/task-code/backfill", async (req, res) => {
  try {
    const rows = await backfillTaskCodes(req.body && req.body.limit);
    return res.status(200).json({ success: true, updated_count: rows.length, data: rows });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
module.exports.genTaskCode = genTaskCode;
module.exports.generateTaskCode = genTaskCode;
module.exports.backfillTaskCodes = backfillTaskCodes;
module.exports.pickPrefix = pickPrefix;
