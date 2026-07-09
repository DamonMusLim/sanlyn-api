import { getPool, setCors } from "./db.js";

const VALID_PRIORITY = new Set(["P0", "P1", "P2", "P3"]);
const LEVEL_MAP = { order: "order", factory: "factory", document: "doc", doc: "doc", logistics: "logi", logi: "logi", approve: "approve", supply: "supply" };
const VALID_OWNER = new Set(["order", "factory", "document", "logistics", "supply_chain"]);
const RISK_BY_PRIORITY = {
  P0: "urgent",
  P1: "high",
  P2: "mid",
  P3: "low",
};

function genTaskId() {
  return "t-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
}

function readSecret(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();
  return req.headers["x-task-ingest-secret"] || "";
}

function cleanString(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

function buildRaw(body) {
  const rawExtra = body.raw_extra && typeof body.raw_extra === "object" && !Array.isArray(body.raw_extra)
    ? body.raw_extra
    : {};

  return {
    closure_substatus: "open",
    recommended_action: cleanString(body.recommended_action),
    entity_type: cleanString(body.entity_type),
    entity_id: cleanString(body.entity_id),
    root_cause: cleanString(body.root_cause),
    issue_type: cleanString(body.issue_type),
    raw_extra: rawExtra,
  };
}

function eventMetadata(source, dedupeKey, priority, rawPatch, body) {
  return {
    source,
    dedupe_key: dedupeKey,
    priority,
    related_order_no: cleanString(body.related_order_no),
    entity_type: rawPatch.entity_type,
    entity_id: rawPatch.entity_id,
    issue_type: rawPatch.issue_type,
  };
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Task-Ingest-Secret");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method === "GET" && req.query && req.query.summary === "1") {
    const expected = process.env.TASK_INGEST_SECRET;
    if (!expected || readSecret(req) !== expected) return res.status(403).json({ success: false, error: "Forbidden" });
    const pool = getPool();
    const r = await pool.query(`SELECT
      COUNT(*) FILTER (WHERE status IN ('open','doing') AND priority='P0')::int AS open_p0,
      COUNT(*) FILTER (WHERE status IN ('open','doing') AND priority='P1')::int AS open_p1,
      COUNT(*) FILTER (WHERE status='done' AND resolved_at >= NOW() - INTERVAL '2 4 hours')::int AS resolved_24h,
      COUNT(*) FILTER (WHERE status IN ('open','doing') AND priority IN ('P0','P1') AND created_at < NOW() - INTERVAL '24 hours')::int AS stuck_over_24h
      FROM tasks WHERE source IS NOT NULL`);
    return res.status(200).json({ success: true, summary: r.rows[0] });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "POST only" });
  }

  const expectedSecret = process.env.TASK_INGEST_SECRET;
  if (!expectedSecret || readSecret(req) !== expectedSecret) {
    return res.status(403).json({ success: false, error: "Forbidden" });
  }

  const b = req.body || {};
  const source = cleanString(b.source);
  const dedupeKey = cleanString(b.dedupe_key);
  const title = cleanString(b.title);
  const priority = cleanString(b.priority) || "P2";

  const missing = [];
  if (!source) missing.push("source");
  if (!dedupeKey) missing.push("dedupe_key");
  if (!title) missing.push("title");
  if (missing.length > 0) {
    return res.status(400).json({ success: false, error: "Missing: " + missing.join(", ") });
  }
  if (!VALID_PRIORITY.has(priority)) {
    return res.status(400).json({ success: false, error: "priority must be P0|P1|P2|P3" });
  }
  if (b.raw_extra !== undefined && (typeof b.raw_extra !== "object" || Array.isArray(b.raw_extra))) {
    return res.status(400).json({ success: false, error: "raw_extra must be an object" });
  }

  const rawPatch = buildRaw(b);
  let ownerObjectType =
    cleanString(b.owner_object_type) ||
    (cleanString(b.related_order_no) ? "order" : cleanString(b.entity_type)) ||
    null;
  if (ownerObjectType && !VALID_OWNER.has(ownerObjectType)) ownerObjectType = null;
  const ownerObjectId =
    cleanString(b.owner_object_id) ||
    cleanString(b.related_order_no) ||
    cleanString(b.entity_id) ||
    dedupeKey;

  const values = {
    id: genTaskId(),
    title,
    taskType: "notification_closure",
    level: LEVEL_MAP[ownerObjectType] || null,
    riskLevel: RISK_BY_PRIORITY[priority],
    ownerObjectType,
    ownerObjectId,
    relatedOrderNo: cleanString(b.related_order_no),
    companyCode: cleanString(b.company_code),
    dueAt: cleanString(b.due_at),
    reason: rawPatch.root_cause || rawPatch.issue_type || "tasks_ingest",
    raw: JSON.stringify(rawPatch),
    source,
    dedupeKey,
    priority,
  };

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const upsert = await client.query(
      `INSERT INTO tasks (
         id, title, task_type, level, status, risk_level,
         owner_object_type, owner_object_id, related_order_no, company_code,
         mode, due_at, reason, raw,
         source, dedupe_key, priority, notify_stage
       ) VALUES (
         $1, $2, $3, $4, 'open', $5,
         $6, $7, $8, $9,
         'owned', $10::timestamptz, $11, $12::jsonb,
         $13, $14, $15, 0
       )
       ON CONFLICT (source, dedupe_key)
         WHERE status NOT IN ('done', 'cancelled')
       DO UPDATE SET
         title = EXCLUDED.title,
         task_type = EXCLUDED.task_type,
         level = EXCLUDED.level,
         risk_level = EXCLUDED.risk_level,
         owner_object_type = EXCLUDED.owner_object_type,
         owner_object_id = EXCLUDED.owner_object_id,
         related_order_no = EXCLUDED.related_order_no,
         company_code = EXCLUDED.company_code,
         due_at = EXCLUDED.due_at,
         reason = EXCLUDED.reason,
         raw = COALESCE(tasks.raw, '{}'::jsonb) || EXCLUDED.raw,
         priority = EXCLUDED.priority
       RETURNING id, status, (xmax = 0) AS created`,
      [
        values.id,
        values.title,
        values.taskType,
        values.level,
        values.riskLevel,
        values.ownerObjectType,
        values.ownerObjectId,
        values.relatedOrderNo,
        values.companyCode,
        values.dueAt,
        values.reason,
        values.raw,
        values.source,
        values.dedupeKey,
        values.priority,
      ]
    );

    const row = upsert.rows[0];
    const created = row.created === true;
    const eventType = created ? "ingested" : "refreshed";

    await client.query(
      `INSERT INTO task_events (
         task_id, event_type, actor_type, actor_id,
         from_status, to_status, note, metadata
       ) VALUES ($1, $2, 'system', $3, $4, $5, $6, $7::jsonb)`,
      [
        row.id,
        eventType,
        source,
        created ? null : row.status,
        row.status,
        title,
        JSON.stringify(eventMetadata(source, dedupeKey, priority, rawPatch, b)),
      ]
    );

    await client.query("COMMIT");
    return res.status(200).json({ success: true, task_id: row.id, created });
  } catch (err) {
    await client.query("ROLLBACK").catch(function() {});
    console.error("[tasks-ingest]", err);
    return res.status(500).json({ success: false, error: String(err.message || err) });
  } finally {
    client.release();
  }
}
