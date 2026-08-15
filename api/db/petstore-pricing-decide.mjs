import { getPool, setCors } from "./db.js";
import { verifyToken } from "./auth.js";
import { resolvePerson, capSources } from "./authz.js";

const MAX_LIMIT = 80;
const DECISION_ACTIONS = new Set(["approve", "reject"]);
const DECIDE_CAP = "price.decide";

function send(res, code, data) {
  res.status(code).json(data);
  return null;
}

function addCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Staff-Token");
}

function text(value, max = 500) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}

function moneyOrNull(value) {
  if (value === "" || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function tokenFrom(req, body = {}) {
  const auth = String(req.headers?.authorization || "");
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  const h = String(req.headers?.["x-staff-token"] || "").trim();
  if (h) return h;
  return String(body.token || req.query?.t || req.query?.token || "").trim();
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

async function requireDecider(req, res, pool, body = {}) {
  const claims = verifyToken(tokenFrom(req, body));
  if (!claims || claims.role !== "staff" || !claims.employee_id) {
    res.status(401).json({ success: false, error: "请从员工端进入" });
    return null;
  }

  const empId = claims.employee_id;
  const person = await resolvePerson({ user: { employee_id: empId } }, { pool, audit: false });
  if (!person) {
    res.status(403).json({ success: false, error: "员工身份未映射，不能审批改价" });
    return null;
  }
  if (capSources(person, DECIDE_CAP).length === 0) {
    res.status(403).json({ success: false, error: "缺少 price.decide 能力" });
    return null;
  }
  return person;
}

function snapshot(row, body, effectivePrice) {
  return {
    intent: {
      id: row.id,
      product_code: row.product_code,
      product_name: row.product_name,
      channel: row.channel,
      old_price: row.old_price,
      target_price: row.target_price,
      status: row.status,
      reason: row.reason,
      author: row.author,
      created_at: row.created_at,
    },
    decision: {
      action: body.action,
      effective_price: effectivePrice,
      note: text(body.note, 500),
    },
    guard: {
      cost_price: row.cost_price,
      cost_state: row.cost_state,
    },
  };
}

async function listIntents(req, res, pool) {
  const limitRaw = Number.parseInt(String(req.query?.limit || "30"), 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_LIMIT) : 30;
  const total = await pool.query(`
    SELECT COUNT(*)::int AS total_pending
    FROM petstore_price_intents
    WHERE status = 'proposed'`);
  const { rows } = await pool.query(`
    SELECT
      p.id, p.product_code, p.product_name, p.channel, p.old_price, p.target_price,
      p.reason, p.author, p.status, p.created_at,
      COALESCE(o.cost_price, s.cost_price) AS cost_price,
      CASE
        WHEN COALESCE(o.cost_price, s.cost_price) IS NULL THEN 'unknown_cost'
        WHEN p.target_price < COALESCE(o.cost_price, s.cost_price) THEN 'blocked'
        ELSE 'ok'
      END AS cost_state,
      o.store_price, o.mt_price, o.ele_price, o.pic_url, o.category, o.cur_stock
    FROM petstore_price_intents p
    LEFT JOIN petstore_ops_row o ON o.product_code = p.product_code
    LEFT JOIN petstore_skus s ON s.product_code = p.product_code
    WHERE p.status = 'proposed'
    ORDER BY p.created_at ASC, p.id ASC
    LIMIT $1`, [limit]);
  send(res, 200, { success: true, total_pending: total.rows[0]?.total_pending || 0, rows });
}

async function decideIntent(req, res, pool, body) {
  if (!DECISION_ACTIONS.has(String(body.action || ""))) {
    return send(res, 400, { success: false, error: "action 只能是 approve / reject" });
  }
  const id = Number.parseInt(String(body.id || ""), 10);
  if (!Number.isFinite(id) || id <= 0) {
    return send(res, 400, { success: false, error: "id 必填" });
  }

  const person = await requireDecider(req, res, pool, body);
  if (!person) return null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = (await client.query(`
      SELECT
        p.id, p.product_code, p.product_name, p.channel, p.old_price, p.target_price,
        p.reason, p.author, p.status, p.created_at,
        COALESCE(o.cost_price, s.cost_price) AS cost_price,
        CASE
          WHEN COALESCE(o.cost_price, s.cost_price) IS NULL THEN 'unknown_cost'
          WHEN p.target_price < COALESCE(o.cost_price, s.cost_price) THEN 'blocked'
          ELSE 'ok'
        END AS cost_state
      FROM petstore_price_intents p
      LEFT JOIN petstore_ops_row o ON o.product_code = p.product_code
      LEFT JOIN petstore_skus s ON s.product_code = p.product_code
      WHERE p.id = $1
      FOR UPDATE OF p`, [id])).rows[0];

    if (!current || current.status !== "proposed") {
      await client.query("ROLLBACK");
      return send(res, 409, { success: false, error: "该改价单已被处理或不存在" });
    }

    const effectivePrice = body.action === "approve"
      ? moneyOrNull(body.effective_price ?? current.target_price)
      : null;
    if (body.action === "approve" && (effectivePrice == null || Number.isNaN(effectivePrice) || effectivePrice <= 0)) {
      await client.query("ROLLBACK");
      return send(res, 400, { success: false, error: "批准时 effective_price 必须是正数" });
    }
    const cost = moneyOrNull(current.cost_price);
    if (body.action === "approve" && cost != null && !Number.isNaN(cost) && effectivePrice < cost) {
      await client.query("ROLLBACK");
      return send(res, 409, { success: false, error: "批准价低于成本，已拦截", cost_price: cost, effective_price: effectivePrice });
    }

    const note = text(body.note, 500);
    const snap = JSON.stringify(snapshot(current, body, effectivePrice));
    const params = [id, person.person_id, note, snap];
    let updated;

    if (body.action === "approve") {
      params.push(effectivePrice);
      updated = await client.query(`
        UPDATE petstore_price_intents
           SET status = 'approved',
               target_price = $5,
               decided_by_person_id = $2,
               decided_at = now(),
               decided_note = $3,
               decided_snapshot = $4::jsonb
         WHERE id = $1 AND status = 'proposed'
         RETURNING id, product_code, product_name, channel, old_price, target_price,
                   status, decided_by_person_id, decided_at, decided_note, decided_snapshot`, params);
    } else {
      updated = await client.query(`
        UPDATE petstore_price_intents
           SET status = 'rejected',
               decided_by_person_id = $2,
               decided_at = now(),
               decided_note = $3,
               decided_snapshot = $4::jsonb
         WHERE id = $1 AND status = 'proposed'
         RETURNING id, product_code, product_name, channel, old_price, target_price,
                   status, decided_by_person_id, decided_at, decided_note, decided_snapshot`, params);
    }

    if (updated.rowCount === 0) {
      await client.query("ROLLBACK");
      return send(res, 409, { success: false, error: "该改价单已被处理" });
    }

    await client.query("COMMIT");
    return send(res, 200, { success: true, row: updated.rows[0] });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("[petstore-pricing-decide]", err);
    return send(res, 500, { success: false, error: "服务异常" });
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  addCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return null;
  }

  const pool = getPool();
  try {
    if (req.method === "GET") {
      const person = await requireDecider(req, res, pool);
      if (!person) return null;
      return listIntents(req, res, pool);
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      return decideIntent(req, res, pool, body);
    }
    return send(res, 405, { success: false, error: "仅支持 GET / POST" });
  } catch (err) {
    console.error("[petstore-pricing-decide]", err);
    return send(res, 500, { success: false, error: "服务异常" });
  }
}