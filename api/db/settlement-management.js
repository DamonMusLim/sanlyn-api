// 核销管理 · finance_settlement_links lens + guarded drafts.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const VERSION = "v2026.08.26-2";
const TABLE = "finance_settlement_links";
const READ_ROLES = new Set(["admin", "finance", "ceo", "superadmin"]);
const WRITE_ROLES = new Set(["admin", "finance", "ceo", "superadmin"]);
const FIELDS = [
  ["id", "核销ID"], ["payment_id", "收付ID"], ["target_type", "核销对象"],
  ["target_id", "对象编号"], ["amount_applied", "核销金额"], ["currency", "币种"],
  ["status", "状态"], ["source", "来源"], ["created_by", "创建人"],
  ["created_at", "创建时间"], ["updated_at", "更新时间"],
];
const REQUIRED = ["payment_id", "target_type", "target_id", "amount_applied", "currency", "status"];
const EDIT_FIELDS = ["payment_id", "target_type", "target_id", "amount_applied", "currency", "status", "source", "created_by"];

function fail(res, status, error) {
  return res.status(status).json({ success: false, error });
}
function clean(v, max = 120) {
  return String(v ?? "").trim().slice(0, max);
}
function has(v) {
  return !(v === null || v === undefined || String(v).trim() === "");
}
function pct(filled, total) {
  if (!total) return null;
  return Math.round((filled * 1000) / total) / 10;
}
function sqlIdent(name) {
  return `"${name.replace(/"/g, '""')}"`;
}
function parseValue(name, v) {
  if (name === "amount_applied") {
    if (!has(v)) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error("amount_applied must be numeric");
    return n;
  }
  return has(v) ? clean(v, 500) : null;
}
function actorOf(req) {
  const u = req.user || {};
  return clean(u.username || u.name || u.email || u.account || u.sub || u.uid || u.id || u.role, 160) || "unknown";
}
async function auditWrite(client, req, action, row, before = null) {
  const detail = {
    module: "settlement-management",
    table: TABLE,
    action,
    id: row?.id || before?.id || null,
    before,
    after: row,
    actor: actorOf(req),
  };
  await client.query(
    `INSERT INTO shipping_plan_audit (plan_id, plan_uid, action, actor, detail)
     VALUES (NULL,$1,$2,$3,$4::jsonb)`,
    [`settlement:${detail.id || "new"}`, `settlement_${action}`, detail.actor, JSON.stringify(detail)]
  );
}
function writeInput(body, cols, requireId) {
  const id = clean(body?.id, 80);
  if (requireId && !id) throw new Error("id required");
  const fields = [];
  const values = [];
  for (const name of EDIT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(body || {}, name)) continue;
    if (!cols.has(name)) throw new Error(`未接入: 缺 ${TABLE}.${name}；当前填充率 未接入`);
    fields.push(name);
    values.push(parseValue(name, body[name]));
  }
  if (!fields.length) throw new Error("no editable fields");
  return { id, fields, values };
}
async function writeRow(pool, req) {
  const client = await pool.connect();
  try {
    if (!(await tableExists(client))) throw new Error(`未接入: 缺 ${TABLE}；当前填充率 未接入`);
    const cols = await tableColumns(client);
    if (!cols.has("id")) throw new Error(`未接入: 缺 ${TABLE}.id；当前填充率 未接入`);
    await client.query("BEGIN");
    if (req.method === "POST") {
      const input = writeInput(req.body, cols, false);
      const names = input.fields.map(sqlIdent);
      const ph = input.fields.map((_, i) => `$${i + 1}`);
      if (cols.has("created_at")) { names.push("created_at"); ph.push("NOW()"); }
      if (cols.has("updated_at")) { names.push("updated_at"); ph.push("NOW()"); }
      const r = await client.query(`INSERT INTO ${TABLE} (${names.join(",")}) VALUES (${ph.join(",")}) RETURNING id::text AS id`, input.values);
      await auditWrite(client, req, "post", r.rows[0]);
      await client.query("COMMIT");
      return { id: r.rows[0]?.id };
    }
    if (req.method === "PATCH") {
      const input = writeInput(req.body, cols, true);
      const current = await client.query(`SELECT * FROM ${TABLE} WHERE id::text=$1 FOR UPDATE`, [input.id]);
      if (!current.rowCount) throw new Error("not found");
      const sets = input.fields.map((x, i) => `${sqlIdent(x)}=$${i + 1}`);
      if (cols.has("updated_at")) sets.push("updated_at=NOW()");
      const r = await client.query(`UPDATE ${TABLE} SET ${sets.join(",")} WHERE id::text=$${input.values.length + 1} RETURNING id::text AS id`, [...input.values, input.id]);
      await auditWrite(client, req, "patch", r.rows[0], current.rows[0]);
      await client.query("COMMIT");
      return { id: r.rows[0]?.id };
    }
    if (req.method === "DELETE") {
      const id = clean(req.body?.id || req.query?.id, 80);
      if (!id) throw new Error("id required");
      if (!cols.has("status")) throw new Error(`未接入: 缺 ${TABLE}.status；当前填充率 未接入`);
      const current = await client.query(`SELECT * FROM ${TABLE} WHERE id::text=$1 FOR UPDATE`, [id]);
      if (!current.rowCount) throw new Error("not found");
      const sets = ["status=$1"];
      if (cols.has("updated_at")) sets.push("updated_at=NOW()");
      const r = await client.query(`UPDATE ${TABLE} SET ${sets.join(",")} WHERE id::text=$2 RETURNING id::text AS id`, ["voided", id]);
      await auditWrite(client, req, "delete", { ...r.rows[0], soft_deleted: true }, current.rows[0]);
      await client.query("COMMIT");
      return { id: r.rows[0]?.id, soft_deleted: true };
    }
    throw new Error("method not allowed");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
async function tableExists(pool) {
  const r = await pool.query("SELECT to_regclass($1) AS name", [`public.${TABLE}`]);
  return Boolean(r.rows[0]?.name);
}
async function tableColumns(pool) {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [TABLE]
  );
  return new Set(r.rows.map((x) => x.column_name));
}
function selectExpr(name, cols) {
  if (name === "id" && cols.has("id")) return "l.id::text AS id";
  return cols.has(name) ? `l.${sqlIdent(name)} AS ${sqlIdent(name)}` : `NULL AS ${sqlIdent(name)}`;
}
function orderBy(cols) {
  return [
    cols.has("created_at") ? "l.created_at DESC NULLS LAST" : "",
    cols.has("updated_at") ? "l.updated_at DESC NULLS LAST" : "",
    cols.has("id") ? "l.id DESC" : "1",
  ].filter(Boolean).join(", ");
}
function whereClause(cols, params, q) {
  const where = [];
  const keyword = clean(q.q || q.search, 100);
  if (keyword) {
    const names = ["id", "payment_id", "target_type", "target_id", "status", "source", "created_by"];
    const parts = names.filter((n) => cols.has(n)).map((n) => `l.${sqlIdent(n)}::text ILIKE $${params.length + 1}`);
    if (parts.length) {
      params.push(`%${keyword}%`);
      where.push(`(${parts.join(" OR ")})`);
    }
  }
  const status = clean(q.status, 40);
  if (status && cols.has("status")) {
    params.push(status);
    where.push(`l.status = $${params.length}`);
  }
  const targetType = clean(q.target_type, 40);
  if (targetType && cols.has("target_type")) {
    params.push(targetType);
    where.push(`l.target_type = $${params.length}`);
  }
  return where.length ? `WHERE ${where.join(" AND ")}` : "";
}
async function coverage(pool, cols) {
  const total = Number((await pool.query(`SELECT COUNT(*)::int AS n FROM ${TABLE}`)).rows[0]?.n || 0);
  const fields = [];
  for (const [name, label] of FIELDS) {
    if (!cols.has(name)) {
      fields.push({ name, label, state: "not_connected", filled: 0, total, fill_rate: null });
      continue;
    }
    const r = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE NULLIF(BTRIM(${sqlIdent(name)}::text), '') IS NOT NULL)::int AS filled FROM ${TABLE}`
    );
    const filled = Number(r.rows[0]?.filled || 0);
    fields.push({ name, label, state: filled ? "ready" : "not_connected", filled, total, fill_rate: pct(filled, total) });
  }
  return { table: TABLE, total_rows: total, fields };
}
function notConnectedReason(cov, missing) {
  const rates = cov.fields
    .filter((f) => REQUIRED.includes(f.name))
    .map((f) => `${f.name} ${f.fill_rate === null ? "未接入" : `${f.fill_rate}%`}`)
    .join("；");
  return `未接入: 缺 ${missing.map((x) => `${TABLE}.${x}`).join(" / ") || "可核销真实链接"}；当前填充率 ${rates || "未接入"}`;
}
async function rows(pool, cols, query) {
  const limit = Math.min(Number.parseInt(query.limit, 10) || 180, 300);
  const params = [];
  const where = whereClause(cols, params, query);
  params.push(limit);
  const selected = FIELDS.map(([name]) => selectExpr(name, cols)).join(", ");
  const r = await pool.query(
    `SELECT ${selected} FROM ${TABLE} l ${where} ORDER BY ${orderBy(cols)} LIMIT $${params.length}`,
    params
  );
  return r.rows.map((x) => ({
    ...x,
    amount_applied: x.amount_applied === null || x.amount_applied === undefined ? null : Number(x.amount_applied),
  }));
}
function alertsFor(row) {
  const out = [];
  if (has(row.amount_applied) && Number(row.amount_applied) < 0) {
    out.push({ kind: "negative_settlement", label: "核销金额为负数", basis: `${TABLE}.amount_applied` });
  }
  if (has(row.amount_applied) && (!has(row.payment_id) || !has(row.target_id))) {
    out.push({ kind: "orphan_settlement", label: "有核销金额但缺收付ID或对象编号", basis: `${TABLE}.payment_id/target_id` });
  }
  return out;
}
function metrics(data) {
  if (!data.length) return { total_links: null, applied_links: null, alert_count: null, by_currency: [] };
  const byCurrency = new Map();
  data.forEach((r) => {
    const c = clean(r.currency, 8).toUpperCase() || "未设置";
    if (!byCurrency.has(c)) byCurrency.set(c, { currency: c, amount: null });
    const n = has(r.amount_applied) ? Number(r.amount_applied) : null;
    if (Number.isFinite(n)) byCurrency.get(c).amount = Math.round(((byCurrency.get(c).amount || 0) + n) * 100) / 100;
  });
  return {
    total_links: data.length,
    applied_links: data.filter((r) => clean(r.status).toLowerCase() === "applied").length,
    alert_count: data.reduce((s, r) => s + r.alerts.length, 0),
    by_currency: Array.from(byCurrency.values()),
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (!READ_ROLES.has(req.user?.role)) return fail(res, 403, "Forbidden");
  if (req.method !== "GET") {
    if (!WRITE_ROLES.has(req.user?.role)) return fail(res, 403, "Forbidden");
    try {
      const changed = await writeRow(getPool(), req);
      return res.status(200).json({ success: true, version: VERSION, changed });
    } catch (err) {
      return fail(res, err.message === "not found" ? 404 : 400, err.message);
    }
  }
  try {
    const pool = getPool();
    if (!(await tableExists(pool))) {
      return res.json({ success: true, version: VERSION, generated_at: new Date().toISOString(), state: "not_connected",
        reason: `未接入: 缺 ${TABLE}；当前填充率 未接入`, data: [], selected: null,
        metrics: metrics([]), coverage: { table: TABLE, total_rows: 0, fields: [] }, missing_tables: [TABLE] });
    }
    const cols = await tableColumns(pool);
    const cov = await coverage(pool, cols);
    const missing = REQUIRED.filter((x) => !cols.has(x) || (cov.fields.find((f) => f.name === x)?.filled || 0) === 0);
    const data = missing.length ? [] : (await rows(pool, cols, req.query || {})).map((r) => ({ ...r, alerts: alertsFor(r) }));
    res.json({ success: true, version: VERSION, generated_at: new Date().toISOString(),
      state: data.length ? "ready" : "not_connected", reason: data.length ? null : notConnectedReason(cov, missing),
      data, selected: data[0] || null, metrics: metrics(data), coverage: cov, missing_tables: [] });
  } catch (err) {
    console.error("[settlement-management]", err);
    fail(res, 500, err.message);
  }
}
