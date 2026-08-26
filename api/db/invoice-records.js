// 开票记录 · finance_invoices_out / finance_invoices_in lens + guarded drafts.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const VERSION = "v2026.08.26-2";
const READ_ROLES = new Set(["admin", "finance", "sales", "ops", "operator", "ceo", "superadmin"]);
const WRITE_ROLES = new Set(["admin", "finance", "ceo", "superadmin"]);
const TABLES = [
  { side: "out", label: "销项发票", table: "finance_invoices_out" },
  { side: "in", label: "进项发票", table: "finance_invoices_in" },
];
const FIELDS = [
  ["invoice_no", "发票号码"], ["invoice_type", "发票类型"], ["issue_date", "开票日期"],
  ["seller_name", "销售方"], ["seller_tax_id", "销售方税号"], ["buyer_name", "购买方"],
  ["buyer_tax_id", "购买方税号"], ["amount_ex_tax", "不含税金额"], ["total_tax", "税额"],
  ["amount_incl_tax", "价税合计"], ["tax_rate", "税率"], ["currency", "币种"],
  ["review_status", "审核状态"], ["void_status", "作废状态"], ["source", "来源"],
  ["contract_nos", "合同号"], ["customs_nos", "报关单号"], ["attachments", "附件"],
  ["line_items", "明细行"], ["created_at", "创建时间"], ["updated_at", "更新时间"],
];
const MONEY_FIELDS = new Set(["amount_ex_tax", "total_tax", "amount_incl_tax", "tax_rate"]);
const EDIT_FIELDS = ["invoice_no", "invoice_type", "issue_date", "seller_name", "seller_tax_id", "buyer_name",
  "buyer_tax_id", "amount_ex_tax", "total_tax", "amount_incl_tax", "tax_rate", "currency", "review_status",
  "void_status", "source", "contract_nos", "customs_nos", "attachments", "line_items"];

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

function colExpr(name, colSet) {
  return colSet.has(name) ? `i.${name}` : `NULL AS ${name}`;
}

function countFilled(rows, name) {
  return rows.filter((r) => has(r[name])).length;
}

function metaFor(side) {
  return TABLES.find((t) => t.side === clean(side, 12));
}

function parseValue(name, v) {
  if (MONEY_FIELDS.has(name)) {
    if (!has(v)) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${name} must be numeric`);
    return n;
  }
  if (name === "issue_date") return has(v) ? clean(v, 20) : null;
  if (name === "contract_nos" || name === "customs_nos") {
    if (Array.isArray(v)) return v.map((x) => clean(x, 80)).filter(Boolean);
    return clean(v, 500).split(/[,\s，、]+/).map((x) => clean(x, 80)).filter(Boolean);
  }
  if (name === "attachments" || name === "line_items") return typeof v === "string" ? JSON.parse(v || "[]") : (v || []);
  return has(v) ? clean(v, 500) : null;
}

function writeInput(body, cols, requireId) {
  const id = clean(body?.id, 80);
  if (requireId && !id) throw new Error("id required");
  const fields = [];
  const values = [];
  for (const name of EDIT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(body || {}, name)) continue;
    if (!cols.has(name)) throw new Error(`未接入: 缺 ${name}；当前填充率 未接入`);
    fields.push(name);
    values.push(parseValue(name, body[name]));
  }
  if (!fields.length) throw new Error("no editable fields");
  return { id, fields, values };
}

async function writeRow(pool, req) {
  const meta = metaFor(req.body?.side);
  if (!meta) throw new Error("side must be out or in");
  if (!(await tableExists(pool, meta.table))) throw new Error(`未接入: 缺 ${meta.table}；当前填充率 未接入`);
  const cols = await columns(pool, meta.table);
  if (!cols.has("id")) throw new Error(`未接入: 缺 ${meta.table}.id；当前填充率 未接入`);
  if (req.method === "POST") {
    const input = writeInput(req.body, cols, false);
    const names = input.fields.map((x) => `"${x}"`);
    const ph = input.fields.map((_, i) => `$${i + 1}`);
    if (cols.has("created_at")) { names.push("created_at"); ph.push("NOW()"); }
    if (cols.has("updated_at")) { names.push("updated_at"); ph.push("NOW()"); }
    const r = await pool.query(`INSERT INTO ${meta.table} (${names.join(",")}) VALUES (${ph.join(",")}) RETURNING id::text AS id`, input.values);
    return { side: meta.side, id: r.rows[0]?.id };
  }
  if (req.method === "PATCH") {
    const input = writeInput(req.body, cols, true);
    const sets = input.fields.map((x, i) => `"${x}"=$${i + 1}`);
    if (cols.has("updated_at")) sets.push("updated_at=NOW()");
    const r = await pool.query(`UPDATE ${meta.table} SET ${sets.join(",")} WHERE id::text=$${input.values.length + 1} RETURNING id::text AS id`, [...input.values, input.id]);
    if (!r.rowCount) throw new Error("not found");
    return { side: meta.side, id: r.rows[0]?.id };
  }
  if (req.method === "DELETE") {
    const id = clean(req.body?.id || req.query?.id, 80);
    if (!id) throw new Error("id required");
    const statusCol = cols.has("void_status") ? "void_status" : (cols.has("review_status") ? "review_status" : "");
    if (!statusCol) throw new Error(`未接入: 缺 ${meta.table}.void_status/review_status；当前填充率 未接入`);
    const sets = [`${statusCol}=$1`];
    if (cols.has("updated_at")) sets.push("updated_at=NOW()");
    const r = await pool.query(`UPDATE ${meta.table} SET ${sets.join(",")} WHERE id::text=$2 RETURNING id::text AS id`, ["voided", id]);
    if (!r.rowCount) throw new Error("not found");
    return { side: meta.side, id: r.rows[0]?.id, soft_deleted: true };
  }
  throw new Error("method not allowed");
}

function coverageFor(meta, rows, colSet, missingTable) {
  const total = rows.length;
  return {
    side: meta.side,
    label: meta.label,
    table: meta.table,
    state: missingTable ? "not_connected" : (total ? "ready" : "not_connected"),
    total_rows: total,
    fields: FIELDS.map(([name, label]) => {
      if (missingTable || !colSet.has(name)) {
        return { name, label, state: "not_connected", filled: 0, total, fill_rate: null };
      }
      const filled = countFilled(rows, name);
      return { name, label, state: filled ? "ready" : "not_connected", filled, total, fill_rate: pct(filled, total) };
    }),
  };
}

function searchClause(colSet, params, query) {
  const q = clean(query.q || query.search, 100);
  if (!q) return [];
  const exprs = ["invoice_no", "seller_name", "buyer_name", "source", "review_status"]
    .filter((name) => colSet.has(name))
    .map((name) => `i.${name}::text ILIKE $${params.length + 1}`);
  if (colSet.has("contract_nos")) exprs.push(`array_to_string(i.contract_nos, ',') ILIKE $${params.length + 1}`);
  if (colSet.has("customs_nos")) exprs.push(`array_to_string(i.customs_nos, ',') ILIKE $${params.length + 1}`);
  if (!exprs.length) return [];
  params.push(`%${q}%`);
  return [`(${exprs.join(" OR ")})`];
}

function statusClause(colSet, params, query) {
  const status = clean(query.status, 60);
  if (!status || !colSet.has("review_status")) return [];
  params.push(status);
  return [`i.review_status::text = $${params.length}`];
}

async function loadRows(pool, meta, colSet, query) {
  const limit = Math.min(parseInt(query.limit, 10) || 160, 300);
  const params = [];
  const where = [
    ...searchClause(colSet, params, query),
    ...statusClause(colSet, params, query),
  ];
  params.push(limit);
  const id = colSet.has("id") ? "i.id::text AS id" : "NULL AS id";
  const fields = FIELDS.map(([name]) => colExpr(name, colSet)).join(", ");
  const order = [
    colSet.has("issue_date") ? "i.issue_date DESC NULLS LAST" : "",
    colSet.has("updated_at") ? "i.updated_at DESC NULLS LAST" : "",
    colSet.has("created_at") ? "i.created_at DESC NULLS LAST" : "",
    colSet.has("id") ? "i.id DESC" : "1",
  ].filter(Boolean).join(", ");
  const r = await pool.query(
    `SELECT $${params.length + 1}::text AS side, $${params.length + 2}::text AS side_label,
            ${id}, ${fields}
       FROM ${meta.table} i
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY ${order}
      LIMIT $${params.length}`,
    [...params, meta.side, meta.label]
  );
  return r.rows;
}

function alertsFor(row, colSet) {
  const alerts = [];
  if (colSet.has("invoice_no") && !has(row.invoice_no) && (has(row.issue_date) || has(row.amount_incl_tax))) {
    alerts.push({ kind: "missing_invoice_no", label: "已见金额/日期但缺发票号码", basis: `${row.side_label}.invoice_no + issue_date/amount_incl_tax` });
  }
  if (colSet.has("amount_incl_tax") && has(row.amount_incl_tax) && Number(row.amount_incl_tax) < 0) {
    alerts.push({ kind: "negative_amount", label: "价税合计为负数", basis: `${row.side_label}.amount_incl_tax` });
  }
  return alerts;
}

function normalize(row, colSet) {
  const out = { side: row.side, side_label: row.side_label, id: row.id, alerts: alertsFor(row, colSet) };
  for (const [name] of FIELDS) out[name] = row[name];
  out.missing = FIELDS
    .filter(([name]) => !colSet.has(name) || !has(row[name]))
    .map(([name, label]) => ({ name, label, reason: colSet.has(name) ? "empty" : "not_connected" }));
  out.missing_count = out.missing.length;
  return out;
}

function metrics(data, coverage) {
  const outRows = data.filter((r) => r.side === "out");
  const inRows = data.filter((r) => r.side === "in");
  return {
    total_records: data.length,
    out_records: outRows.length,
    in_records: inRows.length,
    alert_count: data.reduce((s, r) => s + (r.alerts?.length || 0), 0),
    money_fields: Array.from(MONEY_FIELDS),
    connected_sides: coverage.filter((c) => c.state === "ready").map((c) => c.side),
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
    const wanted = clean(req.query?.side || "all", 12);
    const metas = TABLES.filter((t) => wanted === "all" || wanted === t.side);
    const data = [];
    const coverage = [];
    const missingTables = [];
    for (const meta of metas) {
      const exists = await tableExists(pool, meta.table);
      if (!exists) {
        missingTables.push(meta.table);
        coverage.push(coverageFor(meta, [], new Set(), true));
        continue;
      }
      const colSet = await columns(pool, meta.table);
      const rows = await loadRows(pool, meta, colSet, req.query || {});
      coverage.push(coverageFor(meta, rows, colSet, false));
      rows.forEach((row) => data.push(normalize(row, colSet)));
    }
    res.status(200).json({
      success: true,
      version: VERSION,
      generated_at: new Date().toISOString(),
      state: data.length ? "ready" : "not_connected",
      data,
      selected: data[0] || null,
      metrics: metrics(data, coverage),
      coverage,
      missing_tables: missingTables,
    });
  } catch (err) {
    console.error("[invoice-records]", err);
    fail(res, 500, err.message);
  }
}
