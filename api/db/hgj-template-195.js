// /api/db/hgj-template-195 - read-only HGJ 195 placeholder map and renderer data
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { HGJ_TEMPLATE_195_MAP, HGJ_TEMPLATE_195_TABLES } from "./hgj-template-195-map.js";

const TEMPLATE = {
  code: "hgj-195",
  name: "海管家195模板",
  version: "v2026.09.17-3",
  frontend_route: "/hgj-template-195",
};

const MAP = HGJ_TEMPLATE_195_MAP;
const TABLES = HGJ_TEMPLATE_195_TABLES;
const KEYS = ["id", "_id", "order_no", "contract_no", "shipment_no", "bl_no", "customs_no", "declaration_no", "bill_no", "invoice_no", "link_plan_id"];
const MAX_TEMPLATE_TEXT = 20000;

function clean(value) {
  return value == null ? "" : String(value).trim().slice(0, 180);
}

function templateInput(value) {
  const text = value == null ? "" : String(value);
  if (text.length > MAX_TEMPLATE_TEXT) throw new Error(`template_text too long, max ${MAX_TEMPLATE_TEXT}`);
  return text;
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

function rateText(rowOrValue) {
  const value = typeof rowOrValue === "object" && rowOrValue !== null ? rowOrValue.fill_rate : rowOrValue;
  const total = typeof rowOrValue === "object" && rowOrValue !== null ? rowOrValue.total_count : 1;
  const n = Number(value);
  if (value == null || total == null || Number(total) === 0 || !Number.isFinite(n)) return "未接入";
  return `${Math.round(n * 1000) / 10}%`;
}

function aggregateFill(rows) {
  const readyRows = rows.filter(row => row.state === "ready" && row.total_count != null);
  const total = readyRows.reduce((sum, row) => sum + Number(row.total_count || 0), 0);
  const filled = readyRows.reduce((sum, row) => sum + Number(row.filled_count || 0), 0);
  return { total_count: total || null, filled_count: total ? filled : null, fill_rate: rate(filled, total) };
}

function mapStateCounts(rows) {
  return rows.reduce((out, row) => {
    const key = row.map_state || "not_mapped";
    out[key] = (out[key] || 0) + 1;
    return out;
  }, { mapped: 0, ui_only: 0, not_mapped: 0 });
}

function mappedColumnCount(rows, columns) {
  return rows.filter(row => (
    row.source_table &&
    row.source_column &&
    columns.get(row.source_table)?.has(row.source_column)
  )).length;
}

function mappingFill(rows, columns) {
  const mappable = rows.filter(row => row.map_state !== "ui_only");
  const mapped = mappedColumnCount(mappable, columns);
  return { mapped, total: mappable.length, rate: rate(mapped, mappable.length) };
}

function coverageFields(rows) {
  return rows.map(row => ({
    placeholder: row.placeholder,
    label: row.label,
    group: row.group,
    source_table: row.source_table || "",
    source_column: row.source_column || "",
    field: row.source_table && row.source_column ? `${row.source_table}.${row.source_column}` : "",
    state: row.state,
    reason: row.reason || "",
    total_count: row.total_count ?? null,
    filled_count: row.filled_count ?? null,
    fill_rate: row.fill_rate ?? null,
    can_ignore: false,
  }));
}

function formatValue(value) {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[char]);
}

function placeholderRows() {
  return MAP.map((row, index) => ({
    seq: index + 1,
    group: row.group,
    placeholder: row.placeholder,
    label: row.label,
    source_table: row.source_table || "",
    source_column: row.source_column || "",
    value_policy: row.value_policy || "missing_when_blank",
    map_state: row.map_state || "not_mapped",
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
    if (!row.source_table || !row.source_column) return;
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
    const result = await pool.query(`SELECT count(*) AS total, ${selectSql} FROM public.${tableSql}`);
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
  if (row.map_state === "ui_only") {
    return { state: "not_connected", reason: `缺字段 ${row.group}.${row.label}：海管家界面列，无系统真源字段`, total_count: null, filled_count: null, fill_rate: null };
  }
  if (!row.source_table || !row.source_column) {
    const source = row.source_table ? `${row.source_table}.${row.label}` : `${row.group}.${row.label}`;
    return { state: "not_connected", reason: `缺字段 ${source} 的系统映射列`, total_count: null, filled_count: null, fill_rate: null };
  }
  const source = `${row.source_table}.${row.source_column}`;
  if (!columns.has(row.source_table)) return { state: "not_connected", reason: `缺字段 ${source}：表 ${row.source_table} 未接入`, total_count: null, filled_count: null, fill_rate: null };
  if (!columns.get(row.source_table).has(row.source_column)) return { state: "not_connected", reason: `缺字段 ${source}`, total_count: null, filled_count: null, fill_rate: null };
  const cov = coverage.get(row.placeholder) || { total_count: null, filled_count: null, fill_rate: null };
  if (!cov.total_count) return { state: "not_connected", reason: `缺字段 ${source} 可统计记录`, ...cov };
  if (!cov.filled_count) return { state: "not_connected", reason: `缺字段 ${source} 已填值`, ...cov };
  return { state: "ready", reason: "", ...cov };
}

async function sampleForTable(pool, columns, table, recordKey) {
  if (!columns.has(table)) return null;
  const tableSql = quoteIdent(table);
  const keyColumns = KEYS.filter(key => columns.get(table).has(key));
  if (recordKey) {
    if (!keyColumns.length) return null;
    const valueColumns = MAP
      .filter(row => row.source_table === table && row.source_column && columns.get(table).has(row.source_column))
      .map(row => row.source_column);
    const selectColumns = Array.from(new Set(keyColumns.concat(valueColumns)))
      .map(col => quoteIdent(col))
      .join(", ");
    const clauses = keyColumns.map((key, idx) => `${quoteIdent(key)}::text = $${idx + 1}`);
    const params = keyColumns.map(() => recordKey);
    const hit = await pool.query(`SELECT ${selectColumns} FROM public.${tableSql} WHERE ${clauses.join(" OR ")} LIMIT 1`, params);
    if (hit.rows[0]) return hit.rows[0];
  }
  return null;
}

async function loadValues(pool, columns, rows, recordKey) {
  const tableRows = new Map();
  const tableHits = {};
  for (const table of TABLES) {
    tableRows.set(table, recordKey ? await sampleForTable(pool, columns, table, recordKey) : null);
    tableHits[table] = recordKey ? Boolean(tableRows.get(table)) : null;
  }
  const values = {};
  rows.forEach(row => {
    const data = tableRows.get(row.source_table);
    values[row.placeholder] = data && row.source_column && columns.get(row.source_table)?.has(row.source_column)
      ? formatValue(data[row.source_column])
      : "";
  });
  return { values, table_hits: tableHits };
}

function missingReason(row, tableHits, key = "未知") {
  if (!row) return `缺占位符 ${key} 的映射字段`;
  const source = row.source_table && row.source_column
    ? `${row.source_table}.${row.source_column}`
    : `占位符 ${row.placeholder}`;
  if (row.state === "ready" && tableHits && tableHits[row.source_table] == null) return "缺 record_key 参数，无法匹配当前记录";
  if (row.state === "ready" && tableHits && tableHits[row.source_table] === false) return `缺当前记录 ${row.source_table} 可匹配记录`;
  if (row.state === "ready") return `缺当前记录 ${source} 已填值`;
  return row.reason || `缺字段 ${source}`;
}

function missingPhrase(row, tableHits, key) {
  return `${missingReason(row, tableHits, key)}；当前填充率 ${rateText(row)}`;
}

function missingHtml(row, tableHits, key) {
  const text = `未接入(${missingPhrase(row, tableHits, key)})`;
  return `<span class="hgj-missing" title="${escapeHtml(missingPhrase(row, tableHits, key))}">${escapeHtml(text)}</span>`;
}

function canShowUnset(row, tableHits) {
  return row?.value_policy === "unset_when_blank" && row?.state === "ready" && tableHits?.[row.source_table] === true;
}

function renderText(templateText, values, rows, tableHits) {
  const byKey = new Map(rows.map(row => [row.placeholder, row]));
  const missing = [];
  const seenMissing = new Set();
  let html = "";
  let last = 0;
  const re = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
  String(templateText ?? "").replace(re, (match, key, idx) => {
    const value = values?.[key];
    const row = byKey.get(key);
    html += escapeHtml(String(templateText ?? "").slice(last, idx));
    last = idx + match.length;
    if (!isBlank(value)) html += escapeHtml(value);
    else if (canShowUnset(row, tableHits)) html += escapeHtml("未设置");
    else html += missingHtml(row, tableHits, key);
    return match;
  });
  html += escapeHtml(String(templateText ?? "").slice(last));
  const rendered = String(templateText ?? "").replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, key) => {
    const value = values?.[key];
    if (!isBlank(value)) return value;
    const row = byKey.get(key);
    if (canShowUnset(row, tableHits)) return "未设置";
    if (!seenMissing.has(key)) {
      seenMissing.add(key);
      missing.push({
        placeholder: key,
        source_table: row?.source_table || "",
        source_column: row?.source_column || "",
        reason: missingReason(row, tableHits, key),
        total_count: row?.total_count ?? null,
        filled_count: row?.filled_count ?? null,
        fill_rate: row?.fill_rate ?? null,
      });
    }
    return `未接入(${missingPhrase(row, tableHits, key)})`;
  });
  return {
    rendered,
    rendered_html: html.replace(/\n/g, "<br>"),
    missing_placeholders: missing,
  };
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
    const valueData = await loadValues(pool, columns, rows, recordKey);
    const templateText = req.method === "POST" ? templateInput(req.body?.template_text) : "";
    const preview = !isBlank(templateText)
      ? renderText(templateText, valueData.values, mapped, valueData.table_hits)
      : { rendered: "", rendered_html: "", missing_placeholders: [] };
    const ready = mapped.filter(row => row.state === "ready").length;
    const mappingFillData = mappingFill(mapped, columns);
    const dataFill = aggregateFill(mapped);
    const mapStates = mapStateCounts(mapped);
    return res.json({
      success: true,
      template: TEMPLATE,
      generated_at: new Date().toISOString(),
      record_key: recordKey,
      summary: {
        total: mapped.length,
        ready,
        not_connected: mapped.length - ready,
        mapping_fill_rate: mappingFillData.rate,
        data_fill_rate: dataFill.fill_rate,
        data_total_count: dataFill.total_count,
        data_filled_count: dataFill.filled_count,
      },
      renderer_contract: {
        syntax: "{{placeholder}}",
        placeholder_pattern: "[A-Za-z0-9_]+",
        renderer_api: "window.HgjTemplateRenderer.render(template, values, mappings, {tableHits|table_hits}) => {html, plain, missing, placeholders}",
        renderer_methods: "render, renderInto, renderText, renderPlain, missingInText, placeholders, valueText, missingText",
        max_template_chars: MAX_TEMPLATE_TEXT,
        missing_policy: "无 record_key 不取样本；缺字段、缺记录、空值一律返回未接入并带当前填充率；金额/费率空值仅在真实记录命中后显示未设置。",
        escaping: "前端渲染器对用户内容执行 HTML escape；服务端返回纯文本和已转义 HTML 预览。",
      },
      mapping_contract: {
        template_code: TEMPLATE.code,
        source: "海管家195界面字段蓝图 + 系统真实字段白名单",
        placeholder_count: mapped.length,
        table_count: TABLES.length,
        connected_column_count: mappingFillData.mapped,
        mappable_count: mappingFillData.total,
        mapped_count: mapStates.mapped,
        ui_only_count: mapStates.ui_only,
        not_mapped_count: mapStates.not_mapped,
        source_policy: "只映射已在系统存在并通过 information_schema 校验的字段；未映射字段保持未接入；mapping_fill_rate 是占位符映射覆盖率，data_fill_rate 是真实字段已填值覆盖率。",
        ignore_policy: "未接入类条目不提供忽略操作；本接口只读，不写财务事实表。",
      },
      mappings: mapped,
      coverage_fields: coverageFields(mapped),
      values: valueData.values,
      table_hits: valueData.table_hits,
      preview,
    });
  } catch (err) {
    console.error("[hgj-template-195]", err);
    if (String(err.message || "").startsWith("template_text too long")) {
      return res.status(400).json({ success: false, error: err.message });
    }
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
}
