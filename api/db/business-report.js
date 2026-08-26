// 业务报表 · read-only lens over real order/shipping/customs/invoice sources.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const VERSION = "v2026.08.26-1";
const READ_ROLES = new Set(["admin", "finance", "sales", "ops", "operator", "ceo", "superadmin"]);
const SOURCES = [
  { key: "orders", label: "订单", table: "orders", date: "order_date", fields: ["order_no", "order_date", "customer", "company_name_en", "factory", "status", "total_amount", "currency"] },
  { key: "shipping", label: "海运", table: "shipping_plans", date: "etd", fields: ["shipment_no", "bl_no", "etd", "eta", "customer", "pol", "pod", "container_no", "container_qty", "current_status"] },
  { key: "customs", label: "报关", table: "customs_data", date: "updated_at", fields: ["customs_no", "shipment_no", "contract_no", "customs_dec", "updated_at"] },
  { key: "invoice_out", label: "销项发票", table: "finance_invoices_out", date: "issue_date", fields: ["invoice_no", "issue_date", "buyer_name", "amount_incl_tax", "currency", "review_status"] },
  { key: "invoice_in", label: "进项发票", table: "finance_invoices_in", date: "issue_date", fields: ["invoice_no", "issue_date", "seller_name", "amount_incl_tax", "currency", "review_status"] },
];
const MONEY_FIELDS = new Set(["total_amount", "amount_incl_tax"]);

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

function dateRange(q) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(clean(q.from, 20)) ? clean(q.from, 20) : "2026-01-01";
  const to = /^\d{4}-\d{2}-\d{2}$/.test(clean(q.to, 20)) ? clean(q.to, 20) : "";
  return { from, to };
}

async function coverage(pool, src, colSet, missingTable) {
  if (missingTable) {
    return { ...src, state: "not_connected", total_rows: null, fields: src.fields.map((name) => ({ name, filled: 0, total: null, fill_rate: null, state: "not_connected" })) };
  }
  const total = Number((await pool.query(`SELECT COUNT(*)::int AS n FROM ${src.table}`)).rows[0]?.n || 0);
  const fields = [];
  for (const name of src.fields) {
    if (!colSet.has(name)) {
      fields.push({ name, filled: 0, total, fill_rate: null, state: "not_connected" });
      continue;
    }
    const r = await pool.query(`SELECT COUNT(*) FILTER (WHERE NULLIF(BTRIM("${name}"::text), '') IS NOT NULL)::int AS n FROM ${src.table}`);
    const filled = Number(r.rows[0]?.n || 0);
    fields.push({ name, filled, total, fill_rate: pct(filled, total), state: filled ? "ready" : "not_connected" });
  }
  return { ...src, state: total ? "ready" : "not_connected", total_rows: total, fields };
}

function covNote(c) {
  if (!c || c.total_rows === null) return `未接入: 缺 ${c?.table || "真源表"}；当前填充率 未接入`;
  const parts = (c.fields || []).map((f) => `${f.name} ${f.fill_rate === null ? "未接入" : f.fill_rate + "%"}`);
  return `${c.table} 样本 ${c.total_rows || "未接入"}；当前填充率 ${parts.join("；") || "未接入"}`;
}

async function countBySource(pool, src, colSet, range) {
  if (!colSet.has(src.date)) return { count: null, note: `未接入: 缺 ${src.table}.${src.date}；当前填充率 未接入` };
  const params = [range.from];
  const where = [`${src.date} >= $1::date`];
  if (range.to) {
    params.push(range.to);
    where.push(`${src.date} < ($2::date + interval '1 day')`);
  }
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM ${src.table} WHERE ${where.join(" AND ")}`, params);
  const n = Number(r.rows[0]?.n || 0);
  return { count: n || null, note: n ? `依据 ${src.table}.${src.date}` : `未接入: ${src.table}.${src.date} 日期范围内无真实记录；当前填充率 0/${n}` };
}

async function loadMonthly(pool, colSet, range) {
  if (!colSet.has("order_date")) return [];
  const amount = colSet.has("total_amount") ? "SUM(total_amount) AS order_amount" : "NULL::numeric AS order_amount";
  const params = [range.from];
  const where = ["order_date >= $1::date"];
  if (range.to) {
    params.push(range.to);
    where.push("order_date < ($2::date + interval '1 day')");
  }
  const r = await pool.query(
    `SELECT to_char(date_trunc('month', order_date), 'YYYY-MM') AS month,
            COUNT(*)::int AS order_count, ${amount}
       FROM orders
      WHERE deleted_at IS NULL AND ${where.join(" AND ")}
      GROUP BY 1 ORDER BY 1 DESC LIMIT 12`,
    params
  );
  return r.rows.map((x) => ({ ...x, order_count: Number(x.order_count || 0) || null, order_amount: x.order_amount ?? null }));
}

async function loadRows(pool, colSet, q) {
  const range = dateRange(q);
  const limit = Math.min(parseInt(q.limit, 10) || 120, 300);
  const params = [range.from];
  const where = ["o.deleted_at IS NULL", "o.order_date >= $1::date"];
  if (range.to) {
    params.push(range.to);
    where.push(`o.order_date < ($${params.length}::date + interval '1 day')`);
  }
  const keyword = clean(q.q || q.search, 100);
  if (keyword) {
    params.push(`%${keyword}%`);
    where.push(`(o.order_no ILIKE $${params.length} OR o.contract_no ILIKE $${params.length} OR COALESCE(o.customer, o.company_name_en, '') ILIKE $${params.length})`);
  }
  params.push(limit);
  const customer = colSet.has("company_name_en") ? "COALESCE(NULLIF(o.company_name_en,''), NULLIF(o.customer,'')) AS customer" : "o.customer";
  const amount = colSet.has("total_amount") ? "o.total_amount" : "NULL AS total_amount";
  const currency = colSet.has("currency") ? "o.currency" : "NULL AS currency";
  const factory = colSet.has("factory") ? "o.factory" : "NULL AS factory";
  const r = await pool.query(
    `SELECT o.id::text, o.order_no, o.contract_no, to_char(o.order_date,'YYYY-MM-DD') AS order_date,
            ${customer}, ${factory}, o.status, ${amount}, ${currency}
       FROM orders o
      WHERE ${where.join(" AND ")}
      ORDER BY o.order_date DESC NULLS LAST, o.id DESC
      LIMIT $${params.length}`,
    params
  );
  return r.rows.map((row) => ({
    ...row,
    alerts: ["order_no", "order_date", "customer", "status"].filter((k) => !has(row[k])).map((k) => ({ kind: `missing_${k}`, label: `缺 ${k}`, basis: `orders.${k}` })),
  }));
}

function metric(key, label, countState) {
  return { key, label, value: countState.count, state: countState.count === null ? "not_connected" : "ready", note: countState.note };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (!READ_ROLES.has(req.user?.role)) return fail(res, 403, "Forbidden");
  if (req.method !== "GET") return fail(res, 405, "GET required");
  try {
    const pool = getPool();
    const range = dateRange(req.query || {});
    const out = { coverage: [], metrics: [], rows: [], monthly: [], missing_tables: [] };
    for (const src of SOURCES) {
      const exists = await tableExists(pool, src.table);
      const colSet = exists ? await columns(pool, src.table) : new Set();
      if (!exists) out.missing_tables.push(src.table);
      const c = await coverage(pool, src, colSet, !exists);
      out.coverage.push({ ...c, note: covNote(c) });
      out.metrics.push(metric(src.key, src.label, exists ? await countBySource(pool, src, colSet, range) : { count: null, note: `未接入: 缺 ${src.table}；当前填充率 未接入` }));
      if (src.key === "orders" && exists) {
        out.rows = await loadRows(pool, colSet, req.query || {});
        out.monthly = await loadMonthly(pool, colSet, range);
      }
    }
    res.status(200).json({ success: true, version: VERSION, generated_at: new Date().toISOString(), range, money_fields: Array.from(MONEY_FIELDS), ...out });
  } catch (err) {
    console.error("[business-report]", err);
    fail(res, 500, err.message);
  }
}
