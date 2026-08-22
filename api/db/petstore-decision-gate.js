import crypto from "crypto";
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

function json(res, code, data) { return res.status(code).json(data); }

function addDecisionCorsHeaders(res) {
  const old = String(res.getHeader("Access-Control-Allow-Headers") || "Content-Type, Authorization");
  const needed = ["Content-Type", "Authorization", "X-Pricing-Boss", "X-Clerk-Session"];
  const merged = Array.from(new Set([...old.split(",").map((s) => s.trim()).filter(Boolean), ...needed]));
  res.setHeader("Access-Control-Allow-Headers", merged.join(", "));
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
  return String(process.env.PRICING_BOSS_USERS || "damon_sl,damon")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function requireBoss(req, res) {
  if (req.headers["x-clerk-session"]) {
    json(res, 403, { success: false, error: "clerk_forbidden" });
    return false;
  }
  const payload = decodeJwtPayload(req);
  // 0822:员工端 token 载荷是 {role,employee_id,name},没有 username;
  //      老板从员工端进来时只有 name。两个字段都认,且大小写不敏感。
  const who = String(payload.username || payload.name || "").trim().toLowerCase();
  if (who && bossUsers().includes(who)) return true;
  const expected = process.env.PRICING_BOSS_TOKEN;
  const got = req.headers["x-pricing-boss"];
  if (got && expected && timingTokenMatches(got, expected)) return true;
  json(res, 403, { success: false, error: "boss_forbidden" });
  return false;
}

function actorLabelFromReq(req, body = {}) {
  if (body.actor_label != null && String(body.actor_label).trim()) return String(body.actor_label).trim().slice(0, 120);
  const payload = decodeJwtPayload(req);
  if (payload.username) return String(payload.username).slice(0, 120);
  if (payload.sub) return String(payload.sub).slice(0, 120);
  return "damon";
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function normalizeSessionKey(v) {
  const s = String(v || "").trim();
  return s && s.length <= 120 ? s : "";
}

function normalizeIntentId(v) {
  const n = Number.parseInt(v, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function normalizeIdList(v) {
  if (!Array.isArray(v)) return [];
  return Array.from(new Set(v.map(normalizeIntentId).filter(Boolean)));
}

function normalizeDecision(v) {
  const s = String(v || "").trim();
  return s === "approve" || s === "reject" ? s : "";
}

function normalizeRiskGroup(v) {
  const s = String(v || "").trim().toUpperCase();
  return ["A", "B", "C", "D"].includes(s) ? s : "";
}

function normalizeLimit(v) {
  const n = Number.parseInt(v, 10);
  return Number.isSafeInteger(n) ? Math.min(Math.max(n, 1), 200) : 50;
}

function normalizeOffset(v) {
  const n = Number.parseInt(v, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function normalizePersonId(v) {
  if (v == null || v === "") return null;
  const n = Number.parseInt(v, 10);
  if (!Number.isSafeInteger(n) || n <= 0) return false;
  return n;
}

async function groups(req, res) {
  const { rows } = await getPool().query(`
    SELECT risk_group,
           count(*)::int AS count,
           COALESCE(sum(target_price - old_price), 0)::numeric AS impact_amount,
           bool_and(can_batch)::boolean AS can_batch,
           bool_and(can_autosubmit)::boolean AS can_autosubmit,
           count(*) FILTER (WHERE risk_group = 'D' OR can_autosubmit = false)::int AS manual_required_count
    FROM petstore_decision_groups
    GROUP BY risk_group
  `);
  const map = Object.fromEntries(rows.map((r) => [r.risk_group, r]));
  const order = ["A", "B", "C", "D"];
  const data = order.map((g) => ({
    risk_group: g,
    count: map[g]?.count || 0,
    impact_amount: map[g]?.impact_amount || "0",
    can_batch: g !== "D" && map[g]?.can_batch === true,
    can_autosubmit: map[g]?.can_autosubmit === true,
    manual_required_count: map[g]?.manual_required_count || 0,
  }));
  return json(res, 200, { success: true, total: data.reduce((n, g) => n + g.count, 0), groups: data });
}

async function list(req, res, body) {
  const riskGroup = normalizeRiskGroup(body.risk_group);
  const limit = normalizeLimit(body.limit);
  const offset = normalizeOffset(body.offset);
  const params = [];
  let where = "";
  if (riskGroup) {
    params.push(riskGroup);
    where = "WHERE risk_group = $1";
  }
  params.push(limit, offset);
  const pLimit = params.length - 1;
  const pOffset = params.length;
  const { rows } = await getPool().query(`
    SELECT intent_id, product_code, product_name, channel, old_price, target_price,
           cost_price, days_left, risk_group, can_batch, can_autosubmit, reason
    FROM petstore_decision_groups
    ${where}
    ORDER BY CASE risk_group WHEN 'A' THEN 1 WHEN 'B' THEN 2 WHEN 'C' THEN 3 ELSE 4 END,
             product_code, channel, intent_id
    LIMIT $${pLimit} OFFSET $${pOffset}
  `, params);
  return json(res, 200, { success: true, risk_group: riskGroup || null, limit, offset, rows });
}

async function draftSummary(client, sessionKey) {
  const summary = await client.query(`
    SELECT d.risk_group,
           count(*)::int AS selected_count,
           count(*) FILTER (WHERE d.decision = 'approve')::int AS approve_count,
           count(*) FILTER (WHERE d.decision = 'reject')::int AS reject_count,
           count(*) FILTER (WHERE d.decision = 'approve' AND (g.risk_group = 'D' OR g.can_autosubmit = false))::int AS manual_required_count,
           COALESCE(sum(g.target_price - g.old_price) FILTER (WHERE d.decision = 'approve'), 0)::numeric AS impact_amount
    FROM petstore_decision_draft d
    JOIN petstore_decision_groups g ON g.intent_id = d.intent_id
    WHERE d.session_key = $1
    GROUP BY d.risk_group
  `, [sessionKey]);
  const manual = await client.query(`
    SELECT d.intent_id
    FROM petstore_decision_draft d
    JOIN petstore_decision_groups g ON g.intent_id = d.intent_id
    WHERE d.session_key = $1
      AND d.decision = 'approve'
      AND (g.risk_group = 'D' OR g.can_autosubmit = false)
    ORDER BY d.intent_id
  `, [sessionKey]);
  const groups = Object.fromEntries(["A", "B", "C", "D"].map((g) => [g, {
    risk_group: g, selected_count: 0, approve_count: 0, reject_count: 0,
    manual_required_count: 0, impact_amount: "0",
  }]));
  for (const row of summary.rows) groups[row.risk_group] = row;
  const all = Object.values(groups);
  return {
    groups: all,
    selected_count: all.reduce((n, g) => n + Number(g.selected_count || 0), 0),
    approve_count: all.reduce((n, g) => n + Number(g.approve_count || 0), 0),
    reject_count: all.reduce((n, g) => n + Number(g.reject_count || 0), 0),
    manual_required_count: all.reduce((n, g) => n + Number(g.manual_required_count || 0), 0),
    manual_intent_ids: manual.rows.map((r) => Number(r.intent_id)),
  };
}

async function stage(req, res, body) {
  const sessionKey = normalizeSessionKey(body.session_key);
  const decision = normalizeDecision(body.decision);
  const riskGroup = normalizeRiskGroup(body.risk_group);
  const intentIds = normalizeIdList(body.intent_ids || (body.intent_id ? [body.intent_id] : []));
  if (!sessionKey || !decision) return json(res, 400, { success: false, error: "bad_request" });
  if (!riskGroup && intentIds.length === 0) return json(res, 400, { success: false, error: "target_required" });
  if (riskGroup === "D" && intentIds.length === 0 && decision === "approve") {
    return json(res, 409, { success: false, error: "d_group_requires_line_confirmation" });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const params = [];
    let where = "";
    if (intentIds.length) {
      params.push(intentIds);
      where = "intent_id = ANY($1::bigint[])";
    } else {
      params.push(riskGroup);
      where = "risk_group = $1 AND can_batch = true";
    }
    const source = await client.query(`
      SELECT intent_id, risk_group
      FROM petstore_decision_groups
      WHERE ${where}
      ORDER BY intent_id
    `, params);
    if (!source.rows.length) {
      await client.query("ROLLBACK");
      return json(res, 409, { success: false, error: "no_matching_intents", staged_count: 0 });
    }
    const ids = source.rows.map((r) => r.intent_id);
    const riskById = Object.fromEntries(source.rows.map((r) => [String(r.intent_id), r.risk_group]));
    const upsert = await client.query(`
      INSERT INTO petstore_decision_draft (session_key, intent_id, decision, risk_group, decided_note)
      SELECT $1, x.intent_id, $2, x.risk_group, $3
      FROM unnest($4::bigint[]) AS u(intent_id)
      JOIN petstore_decision_groups x ON x.intent_id = u.intent_id
      ON CONFLICT (session_key, intent_id) DO UPDATE SET
        decision = EXCLUDED.decision,
        risk_group = EXCLUDED.risk_group,
        decided_note = EXCLUDED.decided_note,
        updated_at = now()
      RETURNING intent_id
    `, [sessionKey, decision, body.decided_note == null ? null : String(body.decided_note).slice(0, 500), ids]);
    const summary = await draftSummary(client, sessionKey);
    await client.query("COMMIT");
    return json(res, 200, {
      success: true,
      session_key: sessionKey,
      decision,
      staged_count: upsert.rowCount,
      intent_ids: upsert.rows.map((r) => Number(r.intent_id)),
      risk_groups: riskById,
      summary,
    });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return json(res, 500, { success: false, error: e.message || "server_error" });
  } finally {
    client.release();
  }
}

async function preview(req, res, body) {
  const sessionKey = normalizeSessionKey(body.session_key);
  if (!sessionKey) return json(res, 400, { success: false, error: "session_key_required" });
  const client = await getPool().connect();
  try {
    const summary = await draftSummary(client, sessionKey);
    return json(res, 200, { success: true, session_key: sessionKey, summary });
  } finally {
    client.release();
  }
}

async function submit(req, res, body) {
  const sessionKey = normalizeSessionKey(body.session_key);
  if (!sessionKey) return json(res, 400, { success: false, error: "session_key_required" });
  const personId = normalizePersonId(body.actor_person_id);
  if (personId === false) return json(res, 400, { success: false, error: "bad_actor_person_id" });

  const confirmedManual = body.confirmed_manual === true;
  const manualIntentIds = normalizeIdList(body.manual_intent_ids);
  const client = await getPool().connect();
  try {
    const summary = await draftSummary(client, sessionKey);
    const required = summary.manual_intent_ids;
    const missing = required.filter((id) => !manualIntentIds.includes(id));
    if (required.length && (!confirmedManual || missing.length)) {
      return json(res, 409, {
        success: false,
        error: "manual_confirmation_required",
        changed_count: 0,
        manual_required_count: required.length,
        missing_manual_intent_ids: missing,
      });
    }
    const result = await client.query(
      "SELECT petstore_decision_submit($1, $2::bigint, $3, $4, $5::bigint[]) AS result",
      [sessionKey, personId, actorLabelFromReq(req, body), confirmedManual, manualIntentIds],
    );
    return json(res, 200, { success: true, result: result.rows[0].result });
  } catch (e) {
    const msg = String(e.message || "");
    if (msg.includes("manual_confirmation_required")) {
      return json(res, 409, { success: false, error: "manual_confirmation_required", changed_count: 0 });
    }
    return json(res, 500, { success: false, error: msg || "server_error" });
  } finally {
    client.release();
  }
}

async function discard(req, res, body) {
  const sessionKey = normalizeSessionKey(body.session_key);
  if (!sessionKey) return json(res, 400, { success: false, error: "session_key_required" });
  const result = await getPool().query(
    "SELECT petstore_decision_discard($1, $2) AS result",
    [sessionKey, actorLabelFromReq(req, body)],
  );
  return json(res, 200, { success: true, result: result.rows[0].result });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  addDecisionCorsHeaders(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    const body = req.method === "POST" ? await readBody(req) : req.query || {};
    const action = String(body.action || "").trim();
    if (!requireAuth(req, res)) return;
    if (!requireBoss(req, res)) return;
    if (action === "groups") return groups(req, res);
    if (action === "list") return list(req, res, body);
    if (req.method !== "POST") return json(res, 405, { success: false, error: "post_required" });
    if (action === "stage") return stage(req, res, body);
    if (action === "preview") return preview(req, res, body);
    if (action === "submit") return submit(req, res, body);
    if (action === "discard") return discard(req, res, body);
    return json(res, 400, { success: false, error: "bad_action" });
  } catch (e) {
    return json(res, 500, { success: false, error: e.message || "server_error" });
  }
}
