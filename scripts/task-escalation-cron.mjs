/**
 * task-escalation-cron.mjs
 * 闭环任务 P0/P1 自动追 SLA。默认 DRY_RUN；只有 ESCALATION_LIVE=1 才真写库和推送。
 *
 * 线上建议：
 *   cd /opt/sanlyn-api-test && set -a && source .env && set +a && node scripts/task-escalation-cron.mjs
 */

import "dotenv/config";
import { getPool } from "../api/db.js";

const LIVE = process.env.ESCALATION_LIVE === "1";
const LIMIT = 5;
const NOTIFY_URL = process.env.NOTIFY_URL || "http://127.0.0.1:3791/notify";
const PUBLIC_TASK_URL = "https://sanlyn.cn/public/task.html?task=";
const MS = {
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
};

function asDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function addMs(date, ms) {
  return new Date(date.getTime() + ms);
}

function rawObject(raw) {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function isSnoozed(task, now) {
  const raw = rawObject(task.raw);
  const until = asDate(raw.snooze_until);
  return until && until > now;
}

function todayKey(now) {
  return now.toISOString().slice(0, 10);
}

function nextStage(task, now) {
  if (isSnoozed(task, now)) return null;

  const stage = Number(task.notify_stage || 0);
  const priority = task.priority;
  const createdAt = asDate(task.created_at);
  const lastNotifiedAt = asDate(task.last_notified_at);
  const nextNotifyAt = asDate(task.next_notify_at);
  const acknowledged = Boolean(task.acknowledged_at);
  const resolved = Boolean(task.resolved_at);
  const dueByNextNotify = nextNotifyAt && nextNotifyAt <= now;

  if (!createdAt) return null;

  if (priority === "P0") {
    if (stage === 0 && !acknowledged && addMs(createdAt, 30 * MS.minute) <= now) {
      return { stage: 1, reason: "P0 创建30分钟未确认", nextAt: addMs(now, 2 * MS.hour) };
    }
    if (stage === 1 && !resolved && (dueByNextNotify || addMs(lastNotifiedAt || createdAt, 2 * MS.hour) <= now)) {
      return { stage: 2, reason: "P0 stage1后2小时未解决", nextAt: addMs(now, MS.day) };
    }
    if (stage === 2 && !resolved && (dueByNextNotify || addMs(lastNotifiedAt || createdAt, MS.day) <= now)) {
      return { stage: 3, reason: "P0 stage2后24小时未解决", nextAt: addMs(now, MS.day), daily: true };
    }
    if (stage >= 3 && !resolved && addMs(lastNotifiedAt || createdAt, MS.day) <= now) {
      return { stage: 3, reason: "P0 stage3每日追踪", nextAt: addMs(now, MS.day), daily: true };
    }
  }

  if (priority === "P1") {
    if (stage === 0 && !acknowledged && addMs(createdAt, MS.day) <= now) {
      return { stage: 1, reason: "P1 创建24小时未确认", nextAt: addMs(now, 2 * MS.day) };
    }
    if (stage === 1 && !resolved && (dueByNextNotify || addMs(lastNotifiedAt || createdAt, 3 * MS.day) <= now)) {
      return { stage: 2, reason: "P1 72小时未解决", nextAt: null };
    }
  }

  return null;
}

function idempotencyKey(taskId, stageInfo, now) {
  // stage3 是每日一推，幂等粒度必须带日期；否则唯一键会挡住第二天提醒。
  if (stageInfo.daily) return `${taskId}:stage${stageInfo.stage}:${todayKey(now)}`;
  return `${taskId}:stage${stageInfo.stage}`;
}

function payloadFor(task, stageInfo) {
  const raw = rawObject(task.raw);
  const title = stageInfo.stage >= 2 ? `【加急】${task.title}` : task.title;
  return {
    to: "damon",
    orderNo: task.related_order_no || "",
    cargo: raw.cargo || raw.goods || raw.item || title,
    deadline: task.due_at ? new Date(task.due_at).toISOString() : "",
    containers: raw.containers || raw.container_no || raw.container || "",
    url: `${PUBLIC_TASK_URL}${encodeURIComponent(task.id)}`,
  };
}

async function fetchCandidates(pool, now) {
  const { rows } = await pool.query(
    `SELECT id, title, status, priority, source, dedupe_key, related_order_no,
            assigned_to, acknowledged_at, resolved_at, notify_stage,
            next_notify_at, last_notified_at, raw, due_at, created_at
      FROM tasks
      WHERE status IN ('open', 'doing')
        AND priority IN ('P0', 'P1')
        AND source IS NOT NULL
      ORDER BY
        CASE priority WHEN 'P0' THEN 0 ELSE 1 END,
        COALESCE(next_notify_at, created_at) ASC`,
    []
  );
  return rows;
}

async function reserveAttempt(client, key, task, stageInfo) {
  const res = await client.query(
    `INSERT INTO task_push_attempts
       (task_id, idempotency_key, stage, channel, status)
     VALUES ($1, $2, $3, 'wechat', 'pending')
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [task.id, key, stageInfo.stage]
  );
  return res.rows[0]?.id || null;
}

async function markFailed(client, attemptId, key, err) {
  const msg = String(err?.message || err).slice(0, 1000);
  // 失败要留记录，也要释放原 stage key 给下轮重试。
  await client.query(
    `UPDATE task_push_attempts
        SET status = 'failed',
            error = $1,
            idempotency_key = $2 || ':failed:' || id
      WHERE id = $3`,
    [msg, key, attemptId]
  );
}

async function markSentAndAdvance(client, attemptId, task, stageInfo) {
  await client.query(
    `UPDATE task_push_attempts
        SET status = 'sent', error = NULL
      WHERE id = $1`,
    [attemptId]
  );
  await client.query(
    `UPDATE tasks
        SET notify_stage = $2,
            last_notified_at = NOW(),
            next_notify_at = $3::timestamptz
      WHERE id = $1`,
    [task.id, stageInfo.stage, stageInfo.nextAt ? stageInfo.nextAt.toISOString() : null]
  );
}

async function pushNotify(task, stageInfo) {
  const token = process.env.NOTIFY_TOKEN || "";
  if (!token) throw new Error("NOTIFY_TOKEN missing");

  const resp = await fetch(NOTIFY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-notify-token": token,
    },
    body: JSON.stringify(payloadFor(task, stageInfo)),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`notify ${resp.status}: ${text.slice(0, 500)}`);
}

async function processOne(pool, task, stageInfo, now) {
  const key = idempotencyKey(task.id, stageInfo, now);

  if (!LIVE) {
    console.log(`[DRY] task=${task.id} stage=${stageInfo.stage} key=${key} reason=${stageInfo.reason} title=${task.title}`);
    return { pushed: false, skipped: false };
  }

  const client = await pool.connect();
  let attemptId = null;
  try {
    await client.query("BEGIN");
    attemptId = await reserveAttempt(client, key, task, stageInfo);
    if (!attemptId) {
      await client.query("COMMIT");
      return { pushed: false, skipped: true };
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  try {
    await pushNotify(task, stageInfo);
  } catch (err) {
    const c = await pool.connect();
    try {
      await markFailed(c, attemptId, key, err);
    } finally {
      c.release();
    }
    throw err;
  }

  const c = await pool.connect();
  try {
    await markSentAndAdvance(c, attemptId, task, stageInfo);
  } finally {
    c.release();
  }
  console.log(`[LIVE] pushed task=${task.id} stage=${stageInfo.stage} key=${key} reason=${stageInfo.reason}`);
  return { pushed: true, skipped: false };
}

async function main() {
  const now = new Date();
  const pool = getPool();
  let scanned = 0;
  let due = 0;
  let pushed = 0;
  let skipped = 0;
  let failed = 0;

  try {
    const tasks = await fetchCandidates(pool, now);
    scanned = tasks.length;
    const dueTasks = tasks
      .map((task) => ({ task, stageInfo: nextStage(task, now) }))
      .filter((x) => x.stageInfo)
      .slice(0, LIMIT);
    due = dueTasks.length;

    for (const item of dueTasks) {
      try {
        const r = await processOne(pool, item.task, item.stageInfo, now);
        if (r.pushed) pushed += 1;
        if (r.skipped) skipped += 1;
      } catch (err) {
        failed += 1;
        console.error(`[ERR] task=${item.task.id} stage=${item.stageInfo.stage} ${err.message || err}`);
      }
    }
  } finally {
    await pool.end().catch(() => {});
  }

  console.log(`统计: 扫${scanned}/该推${due}/实推${pushed}/跳过${skipped}/失败${failed}/dry=${LIVE ? "0" : "1"}`);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
