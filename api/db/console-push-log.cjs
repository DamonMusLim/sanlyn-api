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

const router = express.Router();

router.post("/api/console/push-log", async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.audience) return res.status(400).json({ success: false, error: "audience required" });
    if (!body.channel) return res.status(400).json({ success: false, error: "channel required" });
    if (!body.body) return res.status(400).json({ success: false, error: "body required" });

    if (body.dedupe_key) {
      const dup = await getPool().query(
        `SELECT id, pushed_at
           FROM push_log
          WHERE dedupe_key = $1
            AND pushed_at >= now() - interval '1 hour'
          ORDER BY pushed_at DESC
          LIMIT 1`,
        [body.dedupe_key]
      );
      if (dup.rowCount > 0) {
        return res.status(200).json({ success: true, dup: true, data: dup.rows[0] });
      }
    }

    const inserted = await getPool().query(
      `INSERT INTO push_log (
         audience, channel, category, title, body, related_task_id,
         source_script, dedupe_key
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        body.audience,
        body.channel,
        body.category || null,
        body.title || null,
        body.body,
        body.related_task_id || null,
        body.source_script || null,
        body.dedupe_key || null,
      ]
    );
    return res.status(200).json({ success: true, dup: false, data: inserted.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/api/console/push-log", async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const audience = req.query.audience || null;
    const result = await getPool().query(
      `SELECT *
         FROM push_log
        WHERE pushed_at >= (($1::date)::timestamp AT TIME ZONE 'Asia/Shanghai')
          AND pushed_at < ((($1::date + interval '1 day'))::timestamp AT TIME ZONE 'Asia/Shanghai')
          AND ($2::text IS NULL OR audience = $2)
        ORDER BY pushed_at DESC, id DESC`,
      [date, audience]
    );
    return res.status(200).json({
      success: true,
      date,
      audience,
      count: result.rowCount,
      data: result.rows,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
