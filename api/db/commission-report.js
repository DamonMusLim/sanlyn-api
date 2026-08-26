// 提成管理 · read-only lens. Never writes payable/commission facts.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const VERSION = "v2026.08.26-1";
const READ_ROLES = new Set(["admin", "finance", "ceo", "superadmin"]);
const TABLES = ["accounts", "orders"];
const FIELDS = [
  ["accounts", "raw->>isReseller", "代理标记", "(a.raw->>'isReseller')"],
  ["accounts", "raw->>commissionRate", "提成费率", "(a.raw->>'commissionRate')"],
  ["accounts", "raw->>companyCode", "客户编码", "(a.raw->>'companyCode')"],
  ["orders", "company_code", "订单客户编码", "o.company_code"],
  ["orders", "total_amount", "订单金额", "o.total_amount"],
  ["orders", "currency", "币种", "o.currency"],
  ["orders", "raw->>paymentStatus", "回款状态", "(o.raw->>'paymentStatus')"],
  ["orders", "raw->>paymentSettledAt", "回款完成时间", "(o.raw->>'paymentSettledAt')"],
];
const REQUIRED = FIELDS.map((f) => `${f[0]}.${f[1]}`);

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
function monthRange(month) {
  const m = clean(month, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) return null;
  const start = `${m}-01`;
  return { month: m, start, end: `${start}T00:00:00Z` };
}
function defaultMonth() {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - 1, 1);
  return d.toISOString().slice(0, 7);
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
function nextMonthStart(month) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 1));
  return d.toISOString().slice(0, 10);
}
async function fieldCoverage(pool, table, expr) {
  const total = Number((await pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0]?.n || 0);
  const alias = table === "accounts" ? "a" : "o";
  const sql = `SELECT COUNT(*) FILTER (WHERE NULLIF(BTRIM(${expr}::text), '') IS NOT NULL)::int AS filled FROM ${table} ${alias}`;
  const r = await pool.query(sql);
  const filled = Number(r.rows[0]?.filled || 0);
  return { total, filled, fill_rate: pct(filled, total) };
}
async function coverage(pool, colMap) {
  const fields = [];
  for (const [table, name, label, expr] of FIELDS) {
    const physical = name.includes("->>") ? "raw" : name;
    if (!colMap[table]?.has(physical)) {
      fields.push({ table, name, label, state: "not_connected", filled: 0, total: 0, fill_rate: null });
      continue;
    }
    const c = await fieldCoverage(pool, table, expr);
    fields.push({ table, name, label, state: c.filled ? "ready" : "not_connected", ...c });
  }
  return { tables: TABLES, fields };
}
function notConnectedReason(cov, missing) {
  const rates = cov.fields.map((f) => `${f.table}.${f.name} ${f.fill_rate === null ? "未接入" : `${f.fill_rate}%`}`).join("；");
  return `未接入: 缺 ${missing.join(" / ") || "可计算提成的真实字段"}；当前填充率 ${rates || "未接入"}`;
}
async function rows(pool, month, query) {
  const q = clean(query.q || query.search, 80);
  const params = [`${month.start}T00:00:00Z`, `${nextMonthStart(month.month)}T00:00:00Z`];
  const where = [
    "is_reseller IN ('true','1','yes')",
    "payment_status = 'paid'",
    "settled_at >= $1::timestamptz",
    "settled_at < $2::timestamptz",
    "commission_rate IS NOT NULL",
  ];
  if (q) {
    params.push(`%${q}%`);
    where.push(`(username ILIKE $${params.length} OR company ILIKE $${params.length} OR company_code ILIKE $${params.length})`);
  }
  params.push(Math.min(Number.parseInt(query.limit, 10) || 100, 300));
  const r = await pool.query(
    `WITH joined AS (
       SELECT a.username, a.company, a.raw->>'companyCode' AS company_code,
        LOWER(a.raw->>'isReseller') AS is_reseller,
        CASE WHEN a.raw->>'commissionRate' ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (a.raw->>'commissionRate')::numeric END AS commission_rate,
        o.currency,
        CASE WHEN o.total_amount::text ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN o.total_amount::numeric END AS total_amount,
        o.raw->>'paymentStatus' AS payment_status,
        CASE WHEN o.raw->>'paymentSettledAt' ~ '^\\d{4}-\\d{2}-\\d{2}' THEN (o.raw->>'paymentSettledAt')::timestamptz END AS settled_at
       FROM accounts a
       JOIN orders o ON o.company_code = a.raw->>'companyCode'
      )
      SELECT username, company, company_code, commission_rate,
       currency, COUNT(*)::int AS paid_order_count,
       SUM(total_amount)::numeric AS paid_sales,
       SUM(total_amount * commission_rate)::numeric AS commission_due,
       MIN(settled_at)::text AS first_settled_at,
       MAX(settled_at)::text AS last_settled_at
      FROM joined
      WHERE ${where.join(" AND ")}
      GROUP BY username, company, company_code, commission_rate, currency
      ORDER BY commission_due DESC NULLS LAST
      LIMIT $${params.length}`,
    params
  );
  return r.rows.map((x) => ({
    ...x,
    commission_rate: has(x.commission_rate) ? Number(x.commission_rate) : null,
    paid_sales: has(x.paid_sales) ? Number(x.paid_sales) : null,
    commission_due: has(x.commission_due) ? Number(x.commission_due) : null,
    alerts: alertsFor(x),
  }));
}
function alertsFor(row) {
  const out = [];
  if (!has(row.commission_rate)) out.push({ label: "未设置提成费率", basis: "accounts.raw->>commissionRate" });
  if (has(row.commission_rate) && Number(row.commission_rate) < 0) out.push({ label: "提成费率为负数", basis: "accounts.raw->>commissionRate" });
  if (has(row.commission_due) && Number(row.commission_due) < 0) out.push({ label: "应提金额为负数", basis: "orders.total_amount × commissionRate" });
  return out;
}
function metrics(data) {
  if (!data.length) return { reseller_count: null, paid_order_count: null, alert_count: null, by_currency: [] };
  const byCurrency = new Map();
  data.forEach((r) => {
    const c = clean(r.currency, 8).toUpperCase() || "未设置";
    if (!byCurrency.has(c)) byCurrency.set(c, { currency: c, paid_sales: null, commission_due: null });
    const x = byCurrency.get(c);
    for (const k of ["paid_sales", "commission_due"]) {
      const n = has(r[k]) ? Number(r[k]) : null;
      if (Number.isFinite(n)) x[k] = Math.round(((x[k] || 0) + n) * 100) / 100;
    }
  });
  return {
    reseller_count: data.length,
    paid_order_count: data.reduce((s, r) => s + Number(r.paid_order_count || 0), 0),
    alert_count: data.reduce((s, r) => s + r.alerts.length, 0),
    by_currency: Array.from(byCurrency.values()),
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return fail(res, 405, "GET required");
  if (!requireAuth(req, res)) return;
  if (!READ_ROLES.has(req.user?.role)) return fail(res, 403, "Forbidden");
  const month = monthRange(req.query?.month || defaultMonth());
  if (!month) return fail(res, 400, "month must be YYYY-MM");
  try {
    const pool = getPool();
    const existing = {};
    for (const t of TABLES) existing[t] = (await tableExists(pool, t)) ? await columns(pool, t) : null;
    const missingTables = TABLES.filter((t) => !existing[t]);
    const colMap = Object.fromEntries(TABLES.map((t) => [t, existing[t] || new Set()]));
    const cov = missingTables.length ? { tables: TABLES, fields: [] } : await coverage(pool, colMap);
    const missing = missingTables.map((t) => `${t} 表`).concat(
      cov.fields.filter((f) => REQUIRED.includes(`${f.table}.${f.name}`) && (!f.filled || f.fill_rate === null))
        .map((f) => `${f.table}.${f.name}`)
    );
    const data = missing.length ? [] : await rows(pool, month, req.query || {});
    return res.json({
      success: true, version: VERSION, generated_at: new Date().toISOString(), month: month.month,
      state: data.length ? "ready" : "not_connected", reason: data.length ? null : notConnectedReason(cov, missing),
      data, selected: data[0] || null, metrics: metrics(data), coverage: cov, missing_tables: missingTables,
    });
  } catch (err) {
    console.error("[commission-report]", err);
    return fail(res, 500, err.message);
  }
}
