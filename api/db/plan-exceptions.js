import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

function send(res, code, body) {
  return res.status(code).json(body);
}

function positiveInt(v) {
  if (v === null || v === undefined || v === "") return null;
  var n = Number(v);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function cleanText(v) {
  if (v === null || v === undefined) return null;
  var s = String(v).trim();
  return s ? s : null;
}

function currentUser(req) {
  var u = req.user || req.auth || req.sessionUser || {};
  return cleanText(u.staff_no || u.username || u.name || u.user_no || u.id || req.userId || req.username);
}
async function loadTypes(pool) {
  var r = await pool.query(
    `SELECT code, name_cn, category, default_owner_no, default_reviewer_no,
            is_preset, sort_order, active, note
       FROM exception_types
      ORDER BY COALESCE(sort_order, 999999), name_cn, code`
  );
  return r.rows;
}
async function loadOne(pool, shippingPlanId) {
  var types = await loadTypes(pool);
  var r = await pool.query(
    `SELECT e.id, e.exception_code, t.name_cn, t.category, e.note,
            e.owner_no, s.name_cn AS owner_name, e.occurred_at,
            e.resolved_at, e.resolved_by, e.status
       FROM shipping_plan_exceptions e
       JOIN exception_types t ON t.code = e.exception_code
       LEFT JOIN ai_staff s ON s.staff_no = e.owner_no
      WHERE e.shipping_plan_id = $1
      ORDER BY e.status, e.occurred_at DESC NULLS LAST, e.id DESC`,
    [shippingPlanId]
  );
  var open = [];
  var resolved = [];
  r.rows.forEach(function(row) {
    if (row.status === "resolved") {
      resolved.push({
        id: row.id,
        exception_code: row.exception_code,
        name_cn: row.name_cn,
        note: row.note,
        resolved_at: row.resolved_at,
        resolved_by: row.resolved_by,
        occurred_at: row.occurred_at,
      });
    } else {
      open.push({
        id: row.id,
        exception_code: row.exception_code,
        name_cn: row.name_cn,
        category: row.category,
        note: row.note,
        owner_no: row.owner_no,
        owner_name: row.owner_name,
        occurred_at: row.occurred_at,
      });
    }
  });
  return { open: open, resolved: resolved, types: types };
}
async function handleGet(req, res, pool) {
  var shippingPlanId = positiveInt(req.query && req.query.shipping_plan_id);
  if (!shippingPlanId) return send(res, 400, { success: false, error: "shipping_plan_id 必须是正整数" });
  var data = await loadOne(pool, shippingPlanId);
  return send(res, 200, {
    success: true,
    shipping_plan_id: shippingPlanId,
    open: data.open,
    resolved: data.resolved,
    types: data.types,
  });
}

async function handlePost(req, res, pool) {
  var body = req.body || {};
  var shippingPlanId = positiveInt(body.shipping_plan_id);
  var code = cleanText(body.exception_code);
  var note = cleanText(body.note);
  var user = currentUser(req);
  if (!shippingPlanId) return send(res, 400, { success: false, error: "shipping_plan_id 必须是正整数" });
  if (!code) return send(res, 400, { success: false, error: "exception_code 不能为空" });

  var type = await pool.query(
    `SELECT code, default_owner_no, default_reviewer_no
       FROM exception_types
      WHERE code = $1`,
    [code]
  );
  if (!type.rowCount) return send(res, 400, { success: false, error: "异常类型不存在：" + code });

  var exists = await pool.query(
    `SELECT id
       FROM shipping_plan_exceptions
      WHERE shipping_plan_id = $1 AND exception_code = $2 AND status = $3
      LIMIT 1`,
    [shippingPlanId, code, "open"]
  );
  if (exists.rowCount) return send(res, 409, { success: false, error: "这票已有同类型现存异常，不能重复标记" });

  try {
    var row = type.rows[0];
    var inserted = await pool.query(
      `INSERT INTO shipping_plan_exceptions
        (shipping_plan_id, exception_code, status, note, owner_no, reviewer_no, occurred_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, now(), $7)
       RETURNING id`,
      [shippingPlanId, code, "open", note, row.default_owner_no, row.default_reviewer_no, user]
    );
    return send(res, 200, { success: true, id: inserted.rows[0].id });
  } catch (err) {
    if (err && err.code === "23505") {
      return send(res, 409, { success: false, error: "这票已有同类型现存异常，不能重复标记" });
    }
    throw err;
  }
}

async function handlePatch(req, res, pool) {
  var body = req.body || {};
  var id = positiveInt(body.id);
  var action = cleanText(body.action);
  var user = currentUser(req);
  if (!id) return send(res, 400, { success: false, error: "id 必须是正整数" });
  if (action !== "resolve" && action !== "reopen") {
    return send(res, 400, { success: false, error: "action 只能是 resolve 或 reopen" });
  }

  var cur = await pool.query(
    `SELECT id, shipping_plan_id, exception_code, status
       FROM shipping_plan_exceptions
      WHERE id = $1`,
    [id]
  );
  if (!cur.rowCount) return send(res, 404, { success: false, error: "异常记录不存在" });

  if (action === "resolve") {
    await pool.query(
      `UPDATE shipping_plan_exceptions
          SET status = $1, resolved_at = now(), resolved_by = $2, updated_at = now()
        WHERE id = $3`,
      ["resolved", user, id]
    );
    return send(res, 200, { success: true, id: id });
  }

  var row = cur.rows[0];
  var other = await pool.query(
    `SELECT id
       FROM shipping_plan_exceptions
      WHERE shipping_plan_id = $1 AND exception_code = $2 AND status = $3 AND id <> $4
      LIMIT 1`,
    [row.shipping_plan_id, row.exception_code, "open", id]
  );
  if (other.rowCount) return send(res, 409, { success: false, error: "这票已有同类型现存异常，不能重新打开" });

  try {
    await pool.query(
      `UPDATE shipping_plan_exceptions
          SET status = $1, resolved_at = NULL, resolved_by = NULL, updated_at = now()
        WHERE id = $2`,
      ["open", id]
    );
    return send(res, 200, { success: true, id: id });
  } catch (err) {
    if (err && err.code === "23505") {
      return send(res, 409, { success: false, error: "这票已有同类型现存异常，不能重新打开" });
    }
    throw err;
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  var pool = getPool();
  try {
    if (req.method === "GET") return await handleGet(req, res, pool);
    if (req.method === "POST") return await handlePost(req, res, pool);
    if (req.method === "PATCH") return await handlePatch(req, res, pool);
    return send(res, 405, { success: false, error: "GET, POST or PATCH required" });
  } catch (err) {
    console.error("[plan-exceptions]", err);
    return send(res, 500, { success: false, error: "Internal server error" });
  }
}
