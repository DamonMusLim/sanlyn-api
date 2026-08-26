// 收付管理 · finance_payments lens + guarded drafts.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const VERSION = "v2026.08.26-2";
const READ_ROLES = new Set(["admin", "finance", "sales", "ops", "operator", "ceo", "superadmin"]);
const WRITE_ROLES = new Set(["admin", "finance", "ceo", "superadmin"]);
const TABLE = "finance_payments";
const FIELDS = [
  ["payment_no", "收付编号"], ["direction_canonical", "方向"], ["status", "状态"],
  ["payment_date", "收付日期"], ["paid_date", "入账日期"], ["currency", "币种"],
  ["effective_amount", "本次金额"], ["amount_source", "金额来源"], ["customer", "客户"],
  ["customer_en", "客户英文"], ["contract_no", "合同号"], ["order_no", "订单号"],
  ["bank_ref", "银行流水"], ["payment_type", "收付类型"], ["tt_slip_url", "水单"],
  ["invoice_url", "发票附件"], ["created_at", "创建时间"], ["updated_at", "更新时间"],
];
const RAW_AMOUNT_EXPR = `CASE
  WHEN p.raw->>'receivedAmount' IS NULL THEN NULL
  WHEN regexp_replace(p.raw->>'receivedAmount', '[, ]', '', 'g') ~ '^-?\\d+(\\.\\d+)?$'
    THEN regexp_replace(p.raw->>'receivedAmount', '[, ]', '', 'g')::numeric
  ELSE NULL
END`;
const EDIT_FIELDS = ["_id", "payment_no", "direction", "status", "payment_date", "paid_date", "currency",
  "paid_amount", "this_amount", "amount", "customer", "customer_en", "contract_no", "order_no", "bank_ref",
  "pay_type", "type", "tt_slip_url", "invoice_url", "pay_item", "plan_id"];
const NUM_FIELDS = new Set(["paid_amount", "this_amount", "amount"]);

function fail(res, status, error) {
  return res.status(status).json({ success: false, error });
}

function clean(v, max = 120) {
  return String(v ?? "").trim().slice(0, max);
}

function has(v) {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return String(v).trim() !== "";
}

function parseValue(name, v) {
  if (NUM_FIELDS.has(name)) {
    if (!has(v)) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${name} must be numeric`);
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
    module: "receipt-payment-management",
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
    [`payment:${detail.id || "new"}`, `payment_${action}`, detail.actor, JSON.stringify(detail)]
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
    if (!(await tableExists(client, TABLE))) throw new Error(`未接入: 缺 ${TABLE}；当前填充率 未接入`);
    const cols = await columns(client, TABLE);
    if (!cols.has("id")) throw new Error(`未接入: 缺 ${TABLE}.id；当前填充率 未接入`);
    await client.query("BEGIN");
    if (req.method === "POST") {
      const input = writeInput(req.body, cols, false);
      const names = input.fields.map((x) => `"${x}"`);
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
      const sets = input.fields.map((x, i) => `"${x}"=$${i + 1}`);
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

function pct(filled, total) {
  if (!total) return null;
  return Math.round((filled * 1000) / total) / 10;
}

async function tableExists(pool, table) {
  const r = await pool.query("SELECT to_regclass($1) AS name", [`public.${table}`]);
  return Boolean(r.rows[0]?.name);
}

async function columns(pool, table) {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [table]
  );
  return new Set(r.rows.map((x) => x.column_name));
}

function col(name, cols, expr = null) {
  if (expr) return expr;
  return cols.has(name) ? `p.${name}` : `NULL AS ${name}`;
}

function amountExpr(cols) {
  const parts = [];
  if (cols.has("paid_amount")) parts.push("p.paid_amount");
  if (cols.has("this_amount")) parts.push("p.this_amount");
  if (cols.has("raw")) parts.push(RAW_AMOUNT_EXPR);
  if (cols.has("amount")) parts.push("p.amount");
  return parts.length ? `COALESCE(${parts.join(", ")}) AS effective_amount` : "NULL AS effective_amount";
}

function amountSourceExpr(cols) {
  const checks = [];
  if (cols.has("paid_amount")) checks.push("WHEN p.paid_amount IS NOT NULL THEN 'paid_amount'");
  if (cols.has("this_amount")) checks.push("WHEN p.this_amount IS NOT NULL THEN 'this_amount'");
  if (cols.has("raw")) checks.push(`WHEN ${RAW_AMOUNT_EXPR} IS NOT NULL THEN 'raw.receivedAmount'`);
  if (cols.has("amount")) checks.push("WHEN p.amount IS NOT NULL THEN 'amount'");
  return checks.length ? `CASE ${checks.join(" ")} ELSE NULL END AS amount_source` : "NULL AS amount_source";
}

function directionExpr(cols) {
  if (!cols.has("direction")) return "NULL AS direction_canonical";
  return `CASE
    WHEN p.direction IN ('AP','付款','out','refund') THEN 'AP'
    WHEN COALESCE(p.direction,'') NOT IN ('out','refund') THEN 'AR'
    ELSE p.direction
  END AS direction_canonical`;
}

function paymentTypeExpr(cols) {
  if (cols.has("pay_type") && cols.has("type")) return "COALESCE(p.pay_type, p.type) AS payment_type";
  if (cols.has("pay_type")) return "p.pay_type AS payment_type";
  if (cols.has("type")) return "p.type AS payment_type";
  return "NULL AS payment_type";
}

function paymentNoExpr(cols) {
  if (cols.has("_id")) return "p._id AS payment_no";
  if (cols.has("payment_no")) return "p.payment_no AS payment_no";
  if (cols.has("id")) return "p.id::text AS payment_no";
  return "NULL AS payment_no";
}

function searchClause(cols, params, query) {
  const q = clean(query.q || query.search, 100);
  if (!q) return [];
  const names = ["_id", "payment_no", "customer", "customer_en", "contract_no", "order_no", "bank_ref", "status"];
  const exprs = names.filter((n) => cols.has(n)).map((n) => `p.${n}::text ILIKE $${params.length + 1}`);
  if (!exprs.length) return [];
  params.push(`%${q}%`);
  return [`(${exprs.join(" OR ")})`];
}

function filterClauses(cols, params, query, req) {
  const where = searchClause(cols, params, query);
  const direction = clean(query.direction, 20).toUpperCase();
  if (direction && cols.has("direction")) {
    if (direction === "AR") where.push("COALESCE(p.direction,'') NOT IN ('out','refund')");
    else if (direction === "AP") where.push("p.direction IN ('AP','付款','out','refund')");
    else if (direction === "UNCLASSIFIED") where.push("(p.direction IS NULL OR p.direction = '')");
  }
  const status = clean(query.status, 60);
  if (status && cols.has("status")) {
    params.push(status);
    where.push(`p.status = $${params.length}`);
  }
  if (req.user?.role !== "admin") {
    const codes = req.user?.companyCodes || (req.user?.companyCode ? [req.user.companyCode] : null);
    if (!codes?.length) return { error: "Account scope missing — please log out and log in again." };
    if (cols.has("raw") || cols.has("customer_en")) {
      const ph = codes.map((c) => { params.push(c); return `$${params.length}`; });
      const parts = [];
      if (cols.has("raw")) parts.push(`p.raw->>'companyCode' IN (${ph.join(",")})`);
      if (cols.has("customer_en")) parts.push(`p.customer_en ILIKE ANY(ARRAY[${ph.map((p) => p + "||'%'").join(",")}])`);
      where.push(`(${parts.join(" OR ")})`);
    } else {
      return { error: "finance_payments tenant fields not connected" };
    }
  }
  return { where };
}

async function loadRows(pool, cols, query, req) {
  const limit = Math.min(parseInt(query.limit, 10) || 180, 300);
  const params = [];
  const built = filterClauses(cols, params, query, req);
  if (built.error) return built;
  params.push(limit);
  const id = cols.has("id") ? "p.id::text AS id" : "NULL AS id";
  const fields = [
    paymentNoExpr(cols), directionExpr(cols), col("status", cols),
    col("payment_date", cols), col("paid_date", cols), col("currency", cols),
    amountExpr(cols), amountSourceExpr(cols), col("customer", cols), col("customer_en", cols),
    col("contract_no", cols), col("order_no", cols), col("bank_ref", cols), paymentTypeExpr(cols),
    col("tt_slip_url", cols), col("invoice_url", cols), col("created_at", cols), col("updated_at", cols),
  ].join(", ");
  const order = [
    cols.has("payment_date") ? "p.payment_date DESC NULLS LAST" : "",
    cols.has("paid_date") ? "p.paid_date DESC NULLS LAST" : "",
    cols.has("created_at") ? "p.created_at DESC NULLS LAST" : "",
    cols.has("id") ? "p.id DESC" : "1",
  ].filter(Boolean).join(", ");
  const r = await pool.query(
    `SELECT ${id}, ${fields} FROM ${TABLE} p
      ${built.where.length ? "WHERE " + built.where.join(" AND ") : ""}
      ORDER BY ${order} LIMIT $${params.length}`,
    params
  );
  return { rows: r.rows };
}

function fieldStats(rows, cols, missingTable) {
  const total = rows.length;
  return FIELDS.map(([name, label]) => {
    const virtual = ["payment_no", "direction_canonical", "effective_amount", "amount_source", "payment_type"].includes(name);
    const connected = virtual || cols.has(name) || name === "payment_no" && (cols.has("_id") || cols.has("id"));
    if (missingTable || !connected) return { name, label, state: "not_connected", filled: 0, total, fill_rate: null };
    const filled = rows.filter((r) => has(r[name])).length;
    return { name, label, state: filled ? "ready" : "not_connected", filled, total, fill_rate: pct(filled, total) };
  });
}

function alertsFor(r) {
  const alerts = [];
  if (has(r.effective_amount) && Number(r.effective_amount) < 0) {
    alerts.push({ kind: "negative_payment", label: "本次金额为负数", basis: "finance_payments.effective_amount" });
  }
  if (!has(r.contract_no) && !has(r.order_no) && (has(r.effective_amount) || has(r.bank_ref))) {
    alerts.push({ kind: "unmatched_payment", label: "有金额/流水但未匹配合同或订单", basis: "finance_payments.contract_no/order_no" });
  }
  return alerts;
}

function normalize(r, cols) {
  const out = { ...r, alerts: alertsFor(r) };
  out.missing = FIELDS
    .filter(([name]) => !has(r[name]))
    .map(([name, label]) => ({ name, label, reason: cols.has(name) ? "empty" : "not_connected" }));
  out.missing_count = out.missing.length;
  return out;
}

function metrics(rows) {
  if (!rows.length) return { total_records: null, ar_records: null, ap_records: null, alert_count: null, by_currency: [] };
  const byCurrency = new Map();
  rows.forEach((r) => {
    const c = clean(r.currency, 8).toUpperCase() || "未设置";
    if (!byCurrency.has(c)) byCurrency.set(c, { currency: c, ar: null, ap: null });
    const b = byCurrency.get(c);
    const n = has(r.effective_amount) ? Number(r.effective_amount) : null;
    if (!Number.isFinite(n)) return;
    if (r.direction_canonical === "AR") b.ar = Math.round(((b.ar || 0) + n) * 100) / 100;
    if (r.direction_canonical === "AP") b.ap = Math.round(((b.ap || 0) + n) * 100) / 100;
  });
  return {
    total_records: rows.length,
    ar_records: rows.filter((r) => r.direction_canonical === "AR").length,
    ap_records: rows.filter((r) => r.direction_canonical === "AP").length,
    alert_count: rows.reduce((s, r) => s + r.alerts.length, 0),
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
    const exists = await tableExists(pool, TABLE);
    if (!exists) {
      return res.status(200).json({
        success: true, version: VERSION, generated_at: new Date().toISOString(),
        state: "not_connected", data: [], selected: null,
        metrics: metrics([]),
        coverage: [{ table: TABLE, state: "not_connected", total_rows: 0, fields: fieldStats([], new Set(), true) }],
        missing_tables: [TABLE],
      });
    }
    const colSet = await columns(pool, TABLE);
    const loaded = await loadRows(pool, colSet, req.query || {}, req);
    if (loaded.error) return fail(res, 403, loaded.error);
    const data = loaded.rows.map((r) => normalize(r, colSet));
    res.status(200).json({
      success: true, version: VERSION, generated_at: new Date().toISOString(),
      state: data.length ? "ready" : "not_connected",
      data, selected: data[0] || null, metrics: metrics(data),
      coverage: [{ table: TABLE, state: data.length ? "ready" : "not_connected", total_rows: data.length, fields: fieldStats(data, colSet, false) }],
      missing_tables: [],
    });
  } catch (err) {
    console.error("[receipt-payment-management]", err);
    fail(res, 500, err.message);
  }
}
