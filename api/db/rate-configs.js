// api/db/rate-configs.js — 税率/汇率配置库：编辑器 + 改动历史
//   GET  /api/db/rate-configs                     列出全部 active 配置(按 domain 分组)
//   GET  /api/db/rate-configs?domain=fx            按 domain 过滤
//   GET  /api/db/rate-configs?action=history       全部改动历史(最近 200 条)
//   GET  /api/db/rate-configs?action=history&id=X   单条配置的改动历史
//   POST /api/db/rate-configs                       新增一条配置(domain/key/label/rate_value)
//   PATCH /api/db/rate-configs                       改 rate_value/note，自动写 rate_config_history
//
// 全程需 admin/company JWT（税率/汇率是财务口径基础数据，仅管理员可改）。
import { getPool } from "../db.js";
import { verifyToken } from "../auth.js";

function json(res, status, payload) { return res.status(status).json(payload); }
function clean(v) { return String(v ?? "").trim(); }

function requireAdminJwt(req, res) {
  const auth = req.headers.authorization || req.headers.Authorization || "";
  const raw = String(auth).trim();
  const token = raw.startsWith("Bearer ") ? raw.slice(7).trim() : raw;
  const user = verifyToken(token);
  if (!user || !["admin", "company"].includes(user.role)) {
    json(res, 401, { error: "Unauthorized", message: "admin JWT required" });
    return null;
  }
  return user;
}

async function handleList(req, res, pool) {
  const domain = clean(req.query?.domain);
  const includeArchived = clean(req.query?.all) === "1";
  const params = [];
  const where = [];
  if (!includeArchived) where.push(`status = 'active'`);
  if (domain) { params.push(domain); where.push(`domain = $${params.length}`); }
  const sql = `SELECT id, domain, key, label, rate_value, note, status, updated_by, created_at, updated_at
                 FROM rate_configs
                ${where.length ? "WHERE " + where.join(" AND ") : ""}
                ORDER BY domain, key`;
  const r = await pool.query(sql, params);
  return json(res, 200, { rows: r.rows });
}

async function handleHistory(req, res, pool) {
  const id = clean(req.query?.id);
  const params = [];
  let where = "";
  if (id) { params.push(Number(id)); where = "WHERE h.config_id = $1"; }
  const r = await pool.query(
    `SELECT h.id, h.config_id, h.domain, h.key, h.old_value, h.new_value, h.changed_by, h.note, h.changed_at
       FROM rate_config_history h
       ${where}
      ORDER BY h.changed_at DESC
      LIMIT 200`,
    params
  );
  return json(res, 200, { rows: r.rows });
}

async function handleCreate(req, res, pool, user) {
  const b = req.body || {};
  const domain = clean(b.domain);
  const key = clean(b.key);
  if (!["tax_service", "tax_product", "fx"].includes(domain) || !key) {
    return json(res, 400, { error: "domain(tax_service/tax_product/fx) 和 key 必填" });
  }
  const rateValue = Number(b.rate_value);
  if (!Number.isFinite(rateValue)) return json(res, 400, { error: "rate_value 必须是数字" });
  const label = clean(b.label) || null;
  const note = clean(b.note) || null;
  try {
    const ins = await pool.query(
      `INSERT INTO rate_configs (domain, key, label, rate_value, note, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [domain, key, label, rateValue, note, user.username || user.account || user.uid || null]
    );
    return json(res, 200, { ok: true, id: ins.rows[0].id });
  } catch (e) {
    if (e.code === "23505") return json(res, 409, { error: `${domain}/${key} 已存在` });
    throw e;
  }
}

async function handleUpdate(req, res, pool, user) {
  const b = req.body || {};
  const id = Number(b.id);
  if (!Number.isFinite(id)) return json(res, 400, { error: "id required" });
  const cur = await pool.query(`SELECT id, domain, key, rate_value FROM rate_configs WHERE id=$1`, [id]);
  if (!cur.rows[0]) return json(res, 404, { error: "not found" });
  const row = cur.rows[0];

  const hasRate = b.rate_value !== undefined && b.rate_value !== null && b.rate_value !== "";
  const newRate = hasRate ? Number(b.rate_value) : Number(row.rate_value);
  if (hasRate && !Number.isFinite(newRate)) return json(res, 400, { error: "rate_value 必须是数字" });
  const note = b.note !== undefined ? (clean(b.note) || null) : undefined;
  const status = b.status !== undefined ? clean(b.status) : undefined;
  const changedBy = user.username || user.account || user.uid || null;

  const sets = ["updated_by=$1", "updated_at=NOW()"];
  const params = [changedBy];
  if (hasRate) { params.push(newRate); sets.push(`rate_value=$${params.length}`); }
  if (note !== undefined) { params.push(note); sets.push(`note=$${params.length}`); }
  if (status !== undefined) { params.push(status); sets.push(`status=$${params.length}`); }
  params.push(id);

  await pool.query(`UPDATE rate_configs SET ${sets.join(", ")} WHERE id=$${params.length}`, params);

  if (hasRate && Number(row.rate_value) !== newRate) {
    await pool.query(
      `INSERT INTO rate_config_history (config_id, domain, key, old_value, new_value, changed_by, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, row.domain, row.key, row.rate_value, newRate, changedBy, note || null]
    );
  }
  return json(res, 200, { ok: true });
}

export default async function handler(req, res) {
  const user = requireAdminJwt(req, res);
  if (!user) return;
  try {
    const pool = getPool();
    const action = clean(req.query?.action);
    if (req.method === "GET" && action === "history") return await handleHistory(req, res, pool);
    if (req.method === "GET") return await handleList(req, res, pool);
    if (req.method === "POST") return await handleCreate(req, res, pool, user);
    if (req.method === "PATCH") return await handleUpdate(req, res, pool, user);
    return json(res, 405, { error: "Method not allowed" });
  } catch (err) {
    console.error("[rate-configs]", err);
    return json(res, 500, { error: "Internal server error", detail: err.message });
  }
}
