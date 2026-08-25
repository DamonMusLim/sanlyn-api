import crypto from "crypto";
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const TASK_DAY_HOURS = 26;
const PRICE_AUTHOR = "pet_nearexpiry_discount";
const SKILL_ACTORS = [
  "pet_expired_offshelf",
  "pet_nearexpiry_discount",
  "pet-closed-loop",
  "pet_closed_loop",
  "pet_closed_loop_tasks",
];

function json(res, code, data) { return res.status(code).json(data); }

function addCorsHeaders(res) {
  const old = String(res.getHeader("Access-Control-Allow-Headers") || "Content-Type, Authorization");
  const needed = ["Content-Type", "Authorization", "X-Pricing-Boss", "X-Clerk-Session"];
  res.setHeader("Access-Control-Allow-Headers", Array.from(new Set([...old.split(",").map((s) => s.trim()).filter(Boolean), ...needed])).join(", "));
}

function timingTokenMatches(input, expected) {
  if (typeof input !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(input, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function decodeJwtPayload(req) {
  const auth = String(req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return {};
  }
}

function bossUsers() {
  return String(process.env.PRICING_BOSS_USERS || "damon_sl,damon").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function requireBoss(req, res) {
  if (req.headers["x-clerk-session"]) {
    json(res, 403, { success: false, error: "clerk_forbidden" });
    return false;
  }
  const payload = decodeJwtPayload(req);
  const who = String(payload.username || payload.name || "").trim().toLowerCase();
  if (who && bossUsers().includes(who)) return true;
  const expected = process.env.PRICING_BOSS_TOKEN;
  const got = req.headers["x-pricing-boss"];
  if (got && expected && timingTokenMatches(got, expected)) return true;
  json(res, 403, { success: false, error: "boss_forbidden" });
  return false;
}

function ymd(value) {
  const s = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : new Date().toISOString().slice(0, 10);
}

async function hasTable(pool, table) {
  const r = await pool.query("SELECT to_regclass($1) IS NOT NULL AS ok", [table]);
  return r.rows[0]?.ok === true;
}

async function hasColumn(pool, table, column) {
  const r = await pool.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2
    ) AS ok
  `, [table, column]);
  return r.rows[0]?.ok === true;
}

function taskLight(row) {
  if (!row.latest_event_at) return "NOLOG";
  if (row.recent_fail_count > 0) return "FAILED";
  if (row.hours_since_event == null) return "SUSPECT";
  if (Number(row.hours_since_event) <= TASK_DAY_HOURS) return "OK";
  return "SUSPECT";
}

async function loadTasks(pool) {
  if (!(await hasTable(pool, "task_registry"))) return { rows: [], note: "task_registry 不存在" };
  const hasEvents = await hasTable(pool, "task_events");
  const eventSql = hasEvents ? `
    LEFT JOIN LATERAL (
      SELECT max(te.created_at) AS latest_event_at,
             count(*) FILTER (
               WHERE te.created_at >= now() - interval '${TASK_DAY_HOURS} hours'
                 AND (te.event_type ILIKE '%fail%' OR te.note ILIKE '%失败%' OR te.note ILIKE '%error%')
             )::int AS recent_fail_count
      FROM task_events te
      WHERE te.task_id::text IN (tr.task_code, COALESCE(tr.ident, ''))
         OR te.actor_id::text IN (tr.task_code, COALESCE(tr.ident, ''))
    ) ev ON true` : "";
  const { rows } = await pool.query(`
    SELECT tr.task_code, tr.machine, tr.script, tr.cn_name, tr.last_seen_at, tr.retired_at,
           ${hasEvents ? "ev.latest_event_at, ev.recent_fail_count," : "NULL::timestamptz AS latest_event_at, 0::int AS recent_fail_count,"}
           ${hasEvents ? "round(extract(epoch FROM now() - ev.latest_event_at) / 3600, 1)" : "NULL::numeric"} AS hours_since_event
    FROM task_registry tr
    ${eventSql}
    WHERE tr.retired_at IS NULL
      AND (tr.task_code LIKE 'PET-%' OR tr.domain IN ('pet', 'petstore'))
    ORDER BY tr.task_code DESC
    LIMIT 60
  `);
  return {
    rows: rows.map((r) => ({
      ...r,
      light: taskLight(r),
      last_seen_semantics: "last_seen_at 语义未确认",
      cron_evidence: "crontab 实际内容需由部署机回读, 本接口不猜",
    })),
    note: hasEvents ? "" : "task_events 不存在, 只能列登记, 灯号为 NOLOG",
  };
}

async function loadSkills(pool, date) {
  const out = { event_summary: [], price_intents: [], failed_examples: [], external_or_unknown: [] };
  if (await hasTable(pool, "task_events")) {
    const { rows } = await pool.query(`
      SELECT actor_id, event_type, count(*)::int AS count,
             min(created_at) AS first_at, max(created_at) AS last_at
      FROM task_events
      WHERE created_at::date = $1::date
        AND (actor_id = ANY($2::text[]) OR actor_id LIKE 'pet\\_%' OR actor_id LIKE 'pet-%')
      GROUP BY actor_id, event_type
      ORDER BY count DESC, actor_id, event_type
    `, [date, SKILL_ACTORS]);
    out.event_summary = rows;
  }
  if (await hasTable(pool, "petstore_price_intents")) {
    const status = await pool.query(`
      SELECT author, status, count(*)::int AS count,
             min(created_at) AS first_at, max(COALESCE(applied_at, created_at)) AS last_at
      FROM petstore_price_intents
      WHERE author = $1 AND created_at::date = $2::date
      GROUP BY author, status
      ORDER BY status
    `, [PRICE_AUTHOR, date]);
    const failed = await pool.query(`
      SELECT id, product_code, product_name, old_price, target_price, status, result
      FROM petstore_price_intents
      WHERE author = $1 AND created_at::date = $2::date AND status = 'failed'
      ORDER BY id
      LIMIT 20
    `, [PRICE_AUTHOR, date]);
    out.price_intents = status.rows;
    out.failed_examples = failed.rows;
  }
  if ((await hasTable(pool, "petstore_product_status_events")) && (await hasTable(pool, "task_events"))) {
    const hasMetadata = await hasColumn(pool, "task_events", "metadata");
    const eventMatch = hasMetadata
      ? "(te.note ILIKE '%' || se.product_code || '%' OR te.metadata::text ILIKE '%' || se.product_code || '%')"
      : "te.note ILIKE '%' || se.product_code || '%'";
    const ext = await pool.query(`
      SELECT se.product_code, se.product_name, se.old_status, se.new_status, se.detected_at
      FROM petstore_product_status_events se
      WHERE se.detected_at::date = $1::date
        AND se.event_type = 'status_changed'
        AND NOT EXISTS (
          SELECT 1 FROM task_events te
          WHERE te.created_at BETWEEN se.detected_at - interval '30 minutes' AND se.detected_at + interval '30 minutes'
            AND ${eventMatch}
        )
      ORDER BY se.detected_at DESC
      LIMIT 30
    `, [date]);
    out.external_or_unknown = ext.rows;
  }
  return out;
}

async function loadDecision(pool) {
  if (!(await hasTable(pool, "petstore_price_intents"))) return { total: null, groups: [], note: "petstore_price_intents 不存在" };
  const total = await pool.query(`
    SELECT status, count(*)::int AS count,
           round(COALESCE(sum(old_price - target_price), 0)::numeric, 2) AS price_drop_sum
    FROM petstore_price_intents
    WHERE status IN ('pending','proposed','mgr_ok','approved')
    GROUP BY status
    ORDER BY status
  `);
  return {
    total: total.rows.reduce((n, r) => n + Number(r.count || 0), 0),
    groups: total.rows,
    decide_url: "/pet-pricing-decide.html",
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  addCorsHeaders(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return json(res, 405, { success: false, error: "method_not_allowed" });
  try {
    if (!requireAuth(req, res)) return;
    if (!requireBoss(req, res)) return;
    const pool = getPool();
    const date = ymd(req.query?.date);
    const [tasks, skills, decision] = await Promise.all([loadTasks(pool), loadSkills(pool, date), loadDecision(pool)]);
    return json(res, 200, {
      success: true,
      generated_at: new Date().toISOString(),
      date,
      readonly: true,
      tasks,
      skills,
      decision,
    });
  } catch (e) {
    console.error("[petstore-supervision]", e);
    return json(res, 500, { success: false, error: e.message || "server_error" });
  }
}
