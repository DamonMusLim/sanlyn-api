// /api/db/hgj-template-195 - read-only HGJ 195 placeholder map and renderer data
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const TEMPLATE = {
  code: "hgj-195",
  name: "海管家195模板",
  version: "v2026.08.29-1",
};

const MAP = [
  ["basic", "shipment_no", "业务编号", "shipping_plans", "shipment_no"],
  ["basic", "bl_no", "提单号", "shipping_plans", "bl_no"],
  ["basic", "so_no", "SO号", "shipping_plans", "so_no"],
  ["basic", "carrier", "船公司", "shipping_plans", "carrier"],
  ["basic", "vessel", "船名", "shipping_plans", "vessel"],
  ["basic", "voyage", "航次", "shipping_plans", "voyage"],
  ["route", "pol", "起运港", "shipping_plans", "pol"],
  ["route", "pod", "目的港", "shipping_plans", "pod"],
  ["route", "etd", "ETD", "shipping_plans", "etd"],
  ["route", "eta", "ETA", "shipping_plans", "eta"],
  ["party", "customer_name", "客户", "orders", "customer_name"],
  ["party", "factory_name", "工厂", "order_line_items", "factory_name"],
  ["party", "booking_agent", "订舱代理", "local_charges", "company_name"],
  ["party", "settlement_company", "结算单位", "local_charges", "company_name"],
  ["cargo", "contract_no", "合同号", "orders", "contract_no"],
  ["cargo", "order_no", "订单号", "orders", "order_no"],
  ["cargo", "goods_name", "品名", "order_line_items", "product_name"],
  ["cargo", "declaration_name", "申报品名", "order_line_items", "declaration_name"],
  ["cargo", "hs_code", "HS编码", "order_line_items", "hs_code"],
  ["cargo", "qty_ctn", "箱数", "order_line_items", "qty_ctn"],
  ["cargo", "gross_weight", "毛重", "order_line_items", "gw_ctn"],
  ["cargo", "net_weight", "净重", "order_line_items", "nw_ctn"],
  ["cargo", "volume", "体积", "order_line_items", "cbm_ctn"],
  ["customs", "customs_no", "报关单号", "customs_shipments", "customs_no"],
  ["customs", "declaration_amount", "申报货值", "customs_shipments", "declaration_amount"],
  ["customs", "currency", "币种", "customs_shipments", "currency"],
  ["customs", "cargo_type", "货物属性", "customs_shipments", "cargo_type"],
  ["container", "container_no", "柜号", "customs_shipment_containers", "container_no"],
  ["container", "seal_no", "封号", "customs_shipment_containers", "seal_no"],
  ["fee", "fee_name", "费用名称", "freight_bills", "fee_name"],
  ["fee", "fee_currency", "费用币种", "freight_bills", "currency"],
  ["fee", "fee_amount", "费用金额", "freight_bills", "amount"],
  ["fee", "tax_rate", "税率", "freight_bills", "tax_rate"],
  ["fee", "rate_source", "费率来源", "service_rates", "source"],
  ["invoice", "invoice_no", "发票号", "invoice_records", "invoice_no"],
  ["invoice", "invoice_amount", "发票金额", "invoice_records", "amount"],
  ["invoice", "payment_status", "回款状态", "payments", "status"],
];

const TABLES = Array.from(new Set(MAP.map(row => row[3])));
const KEYS = ["id", "_id", "order_no", "contract_no", "shipment_no", "bl_no", "customs_no"];

function clean(value) {
  return value == null ? "" : String(value).trim();
}

function quoteIdent(identifier) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) throw new Error("invalid identifier");
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

function isBlank(value) {
  return value == null || String(value).trim() === "";
}

function rate(filled, total) {
  if (!total) return null;
  return Number((filled / total).toFixed(4));
}

function formatValue(value) {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

function placeholderRows() {
  return MAP.map(row => ({
    group: row[0],
    placeholder: row[1],
    label: row[2],
    source_table: row[3],
    source_column: row[4],
  }));
}

async function loadColumns(pool) {
  const result = await pool.query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = ANY($2::text[])`,
    ["public", TABLES]
  );
  const map = new Map();
  result.rows.forEach(row => {
    if (!map.has(row.table_name)) map.set(row.table_name, new Set());
    map.get(row.table_name).add(row.column_name);
  });
  return map;
}

async function loadCoverage(pool, columns, rows) {
  const grouped = new Map();
  rows.forEach(row => {
    if (!columns.get(row.source_table)?.has(row.source_column)) return;
    if (!grouped.has(row.source_table)) grouped.set(row.source_table, []);
    grouped.get(row.source_table).push(row);
  });

  const out = new Map();
  for (const [table, fields] of grouped.entries()) {
    const tableSql = quoteIdent(table);
    const selectSql = fields.map((field, idx) => {
      const col = quoteIdent(field.source_column);
      return `count(*) FILTER (WHERE ${col} IS NOT NULL AND NULLIF(btrim(${col}::text), '') IS NOT NULL) AS c${idx}`;
    }).join(", ");
    const result = await pool.query(`SELECT count(*) AS total, ${selectSql} FROM ${tableSql}`);
    const data = result.rows[0] || {};
    const total = Number(data.total || 0);
    fields.forEach((field, idx) => {
      const filled = Number(data[`c${idx}`] || 0);
      out.set(field.placeholder, { total_count: total, filled_count: filled, fill_rate: rate(filled, total) });
    });
  }
  return out;
}

function rowState(row, columns, coverage) {
  if (!columns.has(row.source_table)) return { state: "not_connected", reason: `缺表 ${row.source_table}`, total_count: null, filled_count: null, fill_rate: null };
  if (!columns.get(row.source_table).has(row.source_column)) return { state: "not_connected", reason: `缺字段 ${row.source_table}.${row.source_column}`, total_count: null, filled_count: null, fill_rate: null };
  const cov = coverage.get(row.placeholder) || { total_count: null, filled_count: null, fill_rate: null };
  if (!cov.total_count) return { state: "not_connected", reason: `缺 ${row.source_table} 可统计记录`, ...cov };
  if (!cov.filled_count) return { state: "not_connected", reason: `缺 ${row.source_table}.${row.source_column} 已填值`, ...cov };
  return { state: "ready", reason: "", ...cov };
}

async function sampleForTable(pool, columns, table, recordKey) {
  if (!columns.has(table)) return null;
  const tableSql = quoteIdent(table);
  const keyColumns = KEYS.filter(key => columns.get(table).has(key));
  const orderSql = columns.get(table).has("updated_at") ? "updated_at DESC NULLS LAST" : keyColumns.length ? `${quoteIdent(keyColumns[0])} DESC NULLS LAST` : "1";
  if (recordKey && keyColumns.length) {
    const clauses = keyColumns.map((key, idx) => `${quoteIdent(key)}::text = $${idx + 1}`);
    const params = keyColumns.map(() => recordKey);
    const hit = await pool.query(`SELECT * FROM ${tableSql} WHERE ${clauses.join(" OR ")} LIMIT 1`, params);
    if (hit.rows[0]) return hit.rows[0];
  }
  const fallback = await pool.query(`SELECT * FROM ${tableSql} ORDER BY ${orderSql} LIMIT 1`);
  return fallback.rows[0] || null;
}

async function loadValues(pool, columns, rows, recordKey) {
  const tableRows = new Map();
  for (const table of TABLES) tableRows.set(table, await sampleForTable(pool, columns, table, recordKey));
  const values = {};
  rows.forEach(row => {
    const data = tableRows.get(row.source_table);
    values[row.placeholder] = data && columns.get(row.source_table)?.has(row.source_column)
      ? formatValue(data[row.source_column])
      : "";
  });
  return values;
}

function renderText(templateText, values, rows) {
  const missing = [];
  const rendered = clean(templateText).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, key) => {
    const value = values[key];
    if (!isBlank(value)) return value;
    const row = rows.find(item => item.placeholder === key);
    missing.push(key);
    return row ? `未接入(${row.source_table}.${row.source_column})` : "未接入(缺映射)";
  });
  return { rendered, missing_placeholders: Array.from(new Set(missing)) };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ success: false, error: "GET or POST required" });
  if (!requireAuth(req, res)) return;

  try {
    const pool = getPool();
    const rows = placeholderRows();
    const columns = await loadColumns(pool);
    const coverage = await loadCoverage(pool, columns, rows);
    const mapped = rows.map(row => ({ ...row, ...rowState(row, columns, coverage) }));
    const recordKey = clean(req.method === "POST" ? req.body?.record_key : req.query?.record_key);
    const values = await loadValues(pool, columns, rows, recordKey);
    const templateText = req.method === "POST" ? clean(req.body?.template_text) : clean(req.query?.template_text);
    const preview = templateText ? renderText(templateText, values, rows) : { rendered: "", missing_placeholders: [] };
    const ready = mapped.filter(row => row.state === "ready").length;
    return res.json({
      success: true,
      template: TEMPLATE,
      generated_at: new Date().toISOString(),
      record_key: recordKey,
      summary: { total: mapped.length, ready, not_connected: mapped.length - ready, fill_rate: rate(ready, mapped.length) },
      mappings: mapped,
      values,
      preview,
    });
  } catch (err) {
    console.error("[hgj-template-195]", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
}
