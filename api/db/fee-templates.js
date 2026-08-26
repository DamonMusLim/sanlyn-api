// GET /api/db/fee-templates — 费用模板中心，只读真实费率/费目来源。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const SOURCES = [
  {
    key: "local",
    label: "本地费用模板",
    table: "local_charges",
    required: ["carrier", "pol", "company_name", "container_type"],
    amount: ["cost_total", "sell_total", "amount"],
  },
  {
    key: "tariff",
    label: "船司港杂标准",
    table: "carrier_tariff_standards",
    required: ["carrier", "port", "container_type", "charge_item_name", "unit_basis"],
    amount: ["amount_cny"],
  },
  {
    key: "service",
    label: "服务费率模板",
    table: "service_rates",
    required: ["service", "pol", "container_type", "unit"],
    amount: ["rate"],
  },
];

function clean(v, max = 120) {
  return String(v ?? "").trim().slice(0, max);
}

function intVal(v, fallback = 80) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 300) : fallback;
}

function pct(filled, total) {
  if (!total) return 0;
  return Number(((filled / total) * 100).toFixed(1));
}

function tableFor(key) {
  return SOURCES.find((s) => s.key === key) || SOURCES[0];
}

async function tableColumns(pool, table) {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [table]
  );
  return new Set(r.rows.map((x) => x.column_name));
}

async function tableExists(pool, table) {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = $1`,
    [table]
  );
  return r.rowCount > 0;
}

async function coverage(pool, source, cols) {
  if (!(await tableExists(pool, source.table))) {
    return {
      state: "not_connected",
      total_rows: 0,
      missing_fields: source.required.concat(source.amount),
      fields: [],
    };
  }
  const existing = await tableColumns(pool, source.table);
  const wanted = source.required.concat(source.amount);
  const missing = wanted.filter((c) => !existing.has(c));
  const present = wanted.filter((c) => existing.has(c));
  const total = await pool.query(`SELECT COUNT(*)::int AS n FROM ${source.table}`);
  const totalRows = Number(total.rows[0]?.n || 0);
  const fields = [];
  for (const name of present) {
    const q = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE NULLIF(BTRIM(${name}::text), '') IS NOT NULL)::int AS filled
         FROM ${source.table}`
    );
    const filled = Number(q.rows[0]?.filled || 0);
    fields.push({ name, filled, total: totalRows, fill_rate_percent: pct(filled, totalRows) });
  }
  return {
    state: missing.length || totalRows === 0 ? "not_connected" : "ready",
    total_rows: totalRows,
    missing_fields: missing,
    fields,
    available_columns: [...cols].sort(),
  };
}

function selectList(source, cols) {
  const maybe = (name, alias = name) => cols.has(name) ? `${name} AS ${alias}` : `NULL AS ${alias}`;
  if (source.key === "tariff") {
    return [
      maybe("id"), maybe("carrier"), maybe("port", "pol"), "NULL AS pod",
      maybe("container_type"), maybe("charge_item_name", "fee_name"),
      maybe("unit_basis", "basis"), maybe("amount_cny", "cost_amount"),
      "NULL AS sale_amount", "'CNY' AS currency", maybe("valid_from"), maybe("valid_to"),
    ].join(", ");
  }
  if (source.key === "service") {
    return [
      maybe("id"), maybe("service", "carrier"), maybe("pol"), maybe("pod"),
      maybe("container_type"), maybe("tier", "fee_name"), maybe("unit", "basis"),
      maybe("rate", "cost_amount"), "NULL AS sale_amount", maybe("currency"),
      maybe("valid_from"), maybe("valid_to"),
    ].join(", ");
  }
  return [
    maybe("id"), maybe("carrier"), maybe("pol"), maybe("pod"),
    maybe("container_type"), maybe("charge_name", "fee_name"),
    "'整票/柜型' AS basis", maybe("cost_total", "cost_amount"),
    maybe("sell_total", "sale_amount"), maybe("currency"),
    maybe("valid_from"), maybe("valid_until", "valid_to"),
  ].join(", ");
}

function filterSql(q, params, source, cols) {
  const conds = [];
  for (const k of ["carrier", "pol", "pod"]) {
    if (q[k] && cols.has(k)) {
      params.push(`%${clean(q[k])}%`);
      conds.push(`${k} ILIKE $${params.length}`);
    }
  }
  if (source.key === "tariff" && q.pol && cols.has("port")) {
    params.push(`%${clean(q.pol)}%`);
    conds.push(`port ILIKE $${params.length}`);
  }
  return conds.length ? "WHERE " + conds.join(" AND ") : "";
}

async function rows(pool, source, cols, query) {
  const params = [];
  const limit = intVal(query.limit);
  const where = filterSql(query, params, source, cols);
  params.push(limit);
  const order = source.key === "tariff" ? "carrier, pol, container_type, fee_name"
    : source.key === "service" ? "carrier, pol, pod, container_type"
    : "carrier, pol, pod, container_type";
  const r = await pool.query(
    `SELECT ${selectList(source, cols)}
       FROM ${source.table}
       ${where}
      ORDER BY ${order}
      LIMIT $${params.length}`,
    params
  );
  return r.rows;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "Method not allowed" });
  try {
    const pool = getPool();
    const source = tableFor(clean(req.query?.source || "local", 24));
    const cols = (await tableExists(pool, source.table)) ? await tableColumns(pool, source.table) : new Set();
    const stats = await coverage(pool, source, cols);
    const data = stats.state === "ready" ? await rows(pool, source, cols, req.query || {}) : [];
    return res.status(200).json({
      success: true,
      generated_at: new Date().toISOString(),
      version: "v2026.08.26-1",
      source: { key: source.key, label: source.label, table: source.table },
      sources: SOURCES.map(({ key, label, table }) => ({ key, label, table })),
      state: stats.state,
      coverage: stats,
      rows: data,
    });
  } catch (err) {
    console.error("[fee-templates]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
