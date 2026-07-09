import { getPool, setCors } from "./db.js";

const ACTIONS = new Set(["acknowledge", "assign", "start", "resolve", "ignore", "snooze"]);
const ACTIVE_STATUSES = new Set(["open", "doing"]);

function asText(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

function rawOf(task) {
  if (!task || !task.raw) return {};
  if (typeof task.raw === "string") {
    try { return JSON.parse(task.raw); } catch { return {}; }
  }
  return task.raw;
}

function userId(user) {
  return asText(user && (user.uid || user.id || user.sub || user.account));
}

function userName(user) {
  return asText(user && (user.username || user.name || user.email || user.account));
}

function userCodes(user) {
  if (!user) return [];
  if (Array.isArray(user.companyCodes)) return user.companyCodes.map(asText).filter(Boolean);
  const one = asText(user.companyCode || user.company_code);
  return one ? [one] : [];
}

function isFinanceTask(task) {
  const raw = rawOf(task);
  const source = asText(task.source).toLowerCase();
  const templateKey = asText(raw.template_key).toLowerCase();
  return source.includes("finance") || templateKey.includes("finance");
}

function isFinanceOrRebateTemplate(task) {
  const key = asText(rawOf(task).template_key).toLowerCase();
  return key.includes("finance") || key.includes("rebate");
}

function hasEvidence(evidence) {
  if (Array.isArray(evidence)) return evidence.length > 0;
  if (evidence && typeof evidence === "object") return Object.keys(evidence).length > 0;
  return !!asText(evidence);
}

function canAccessTask(task, user) {
  if (!user) return false;
  const role = asText(user.role).toLowerCase();
  if (isFinanceTask(task) && role !== "admin" && role !== "finance") return false;
  if (role === "admin") return true;

  const uid = userId(user);
  if (uid && asText(task.assignee_user_id) === uid) return true;
  if (uid && asText(task.owner_user_id) === uid) return true;

  const uname = userName(user);
  if (uname && asText(task.assigned_to) === uname) return true;

  const codes = userCodes(user);
  if (!codes.length) return false;
  return [task.company_code, task.factory_company_code, task.owner_object_id]
    .map(asText)
    .some((code) => code && codes.includes(code));
}

async function fetchTask(pool, id, lock) {
  const sql = `SELECT * FROM tasks WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`;
  const r = await pool.query(sql, [id]);
  return r.rows[0] || null;
}

async function fetchEvents(pool, id) {
  const r = await pool.query(
    `SELECT id, task_id, event_type, actor_type, actor_id, from_status,
            to_status, note, metadata, created_at
       FROM task_events
      WHERE task_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 20`,
    [id]
  );
  return r.rows;
}

async function insertEvent(client, task, user, action, fromStatus, toStatus, note, metadata) {
  await client.query(
    `INSERT INTO task_events (
       task_id, event_type, actor_type, actor_id,
       from_status, to_status, note, metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      task.id,
      action,
      asText(user.role) || "user",
      userId(user) || userName(user) || "unknown",
      fromStatus || null,
      toStatus || null,
      note || null,
      JSON.stringify(metadata || {}),
    ]
  );
}

function validateAction(task, body) {
  const action = asText(body.action);
  if (!ACTIONS.has(action)) return "action must be acknowledge|assign|start|resolve|ignore|snooze";
  if (action === "assign" && !asText(body.assignee)) return "assignee required";
  if (action === "resolve" && !asText(body.note) && !hasEvidence(body.evidence)) {
    return "resolve requires note or evidence";
  }
  if (action === "resolve" && isFinanceOrRebateTemplate(task) && !hasEvidence(body.evidence)) {
    return "财务类需证据";
  }
  if (action === "ignore" && !asText(body.note)) return "ignore requires note";
  if (action === "snooze" && !asText(body.until)) return "until required";
  if (action === "snooze" && Number.isNaN(Date.parse(body.until))) return "until must be a valid datetime";
  return "";
}

function alreadyDone(task, action) {
  const raw = rawOf(task);
  if (action === "acknowledge") return !!task.acknowledged_at || raw.closure_substatus === "acknowledged";
  if (action === "start") return task.status === "doing";
  if (action === "resolve") return task.status === "done";
  if (action === "ignore") return task.status === "cancelled" && raw.resolution_type === "ignored";
  if (action === "snooze") return false;
  if (action === "assign") return false;
  return false;
}

async function applyAction(client, task, user, body) {
  const action = asText(body.action);
  const note = asText(body.note) || null;
  const evidence = body.evidence === undefined ? null : body.evidence;
  const fromStatus = task.status;

  if (alreadyDone(task, action)) {
    return { task, action, noop: true };
  }
  if (!ACTIVE_STATUSES.has(task.status)) {
    const err = new Error("task is " + task.status + ", action not allowed");
    err.status = 409;
    throw err;
  }

  let sql;
  let params;
  let toStatus = task.status;

  if (action === "acknowledge") {
    sql = `UPDATE tasks
              SET acknowledged_at = COALESCE(acknowledged_at, NOW()),
                  raw = COALESCE(raw, '{}'::jsonb)
                        || jsonb_build_object('closure_substatus', 'acknowledged'),
                  updated_at = NOW()
            WHERE id = $1 RETURNING *`;
    params = [task.id];
  } else if (action === "assign") {
    toStatus = "doing";
    sql = `UPDATE tasks
              SET assigned_to = $2,
                  status = 'doing',
                  raw = COALESCE(raw, '{}'::jsonb)
                        || jsonb_build_object('closure_substatus', 'assigned'),
                  updated_at = NOW()
            WHERE id = $1 RETURNING *`;
    params = [task.id, asText(body.assignee)];
  } else if (action === "start") {
    toStatus = "doing";
    sql = `UPDATE tasks
              SET status = 'doing',
                  raw = COALESCE(raw, '{}'::jsonb)
                        || jsonb_build_object('closure_substatus', 'started'),
                  updated_at = NOW()
            WHERE id = $1 RETURNING *`;
    params = [task.id];
  } else if (action === "resolve") {
    toStatus = "done";
    sql = `UPDATE tasks
              SET status = 'done',
                  resolved_at = COALESCE(resolved_at, NOW()),
                  raw = COALESCE(raw, '{}'::jsonb)
                        || jsonb_build_object('closure_substatus', 'resolved'),
                  updated_at = NOW()
            WHERE id = $1 RETURNING *`;
    params = [task.id];
  } else if (action === "ignore") {
    toStatus = "cancelled";
    sql = `UPDATE tasks
              SET status = 'cancelled',
                  resolved_at = COALESCE(resolved_at, NOW()),
                  raw = COALESCE(raw, '{}'::jsonb)
                        || jsonb_build_object(
                             'closure_substatus', 'ignored',
                             'resolution_type', 'ignored'
                           ),
                  updated_at = NOW()
            WHERE id = $1 RETURNING *`;
    params = [task.id];
  } else if (action === "snooze") {
    sql = `UPDATE tasks
              SET next_notify_at = $2::timestamptz,
                  raw = COALESCE(raw, '{}'::jsonb)
                        || jsonb_build_object(
                             'closure_substatus', 'snoozed',
                             'snooze_until', $2::text
                           ),
                  updated_at = NOW()
            WHERE id = $1 RETURNING *`;
    params = [task.id, body.until];
  }

  const r = await client.query(sql, params);
  const updated = r.rows[0];
  await insertEvent(client, task, user, action, fromStatus, toStatus, note, {
    evidence,
    assignee: action === "assign" ? asText(body.assignee) : undefined,
    until: action === "snooze" ? asText(body.until) : undefined,
  });
  return { task: updated, action, noop: false };
}

async function summary(pool) {
  const r = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('open', 'doing') AND priority = 'P0')::int AS open_p0,
       COUNT(*) FILTER (WHERE status IN ('open', 'doing') AND priority = 'P1')::int AS open_p1,
       COUNT(*) FILTER (WHERE status = 'done' AND resolved_at >= CURRENT_DATE)::int AS resolved_today,
       COUNT(*) FILTER (
         WHERE status = 'open'
           AND COALESCE(created_at, NOW()) < NOW() - INTERVAL '24 hours'
       )::int AS stuck
      FROM tasks`
  );
  return r.rows[0];
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!req.user) return res.status(401).json({ success: false, error: "Unauthorized" });

  const pool = getPool();

  if (req.method === "GET" && req.query.summary === "1") {
    try {
      return res.status(200).json({ success: true, data: await summary(pool) });
    } catch (err) {
      console.error("[tasks-closure summary]", err);
      return res.status(500).json({ success: false, error: String(err.message || err) });
    }
  }

  if (req.method === "GET") {
    const id = asText(req.query.id);
    if (!id) return res.status(400).json({ success: false, error: "id required" });
    try {
      const task = await fetchTask(pool, id, false);
      if (!task) return res.status(404).json({ success: false, error: "task not found" });
      if (!canAccessTask(task, req.user)) return res.status(403).json({ success: false, error: "Forbidden" });
      const events = await fetchEvents(pool, id);
      return res.status(200).json({ success: true, data: { task, events } });
    } catch (err) {
      console.error("[tasks-closure GET]", err);
      return res.status(500).json({ success: false, error: String(err.message || err) });
    }
  }

  if (req.method === "POST") {
    const body = req.body || {};
    const id = asText(body.id || req.query.id);
    if (!id) return res.status(400).json({ success: false, error: "id required" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const task = await fetchTask(client, id, true);
      if (!task) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, error: "task not found" });
      }
      if (!canAccessTask(task, req.user)) {
        await client.query("ROLLBACK");
        return res.status(403).json({ success: false, error: "Forbidden" });
      }
      const validationError = validateAction(task, body);
      if (validationError) {
        await client.query("ROLLBACK");
        const code = validationError === "财务类需证据" ? 400 : 400;
        return res.status(code).json({ success: false, error: validationError });
      }

      const out = await applyAction(client, task, req.user, body);
      await client.query("COMMIT");
      return res.status(200).json({ success: true, data: out.task, action: out.action, noop: out.noop });
    } catch (err) {
      await client.query("ROLLBACK").catch(function() {});
      console.error("[tasks-closure POST]", err);
      return res.status(err.status || 500).json({ success: false, error: String(err.message || err) });
    } finally {
      client.release();
    }
  }

  return res.status(405).json({ success: false, error: "Method not allowed" });
}
