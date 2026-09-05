// /api/db/field-engine - read-only field definitions for the generic HY grid
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

class IdentifierError extends Error {}

function clean(value) {
  return value == null ? "" : String(value).trim();
}

function quoteIdentifier(identifier) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new IdentifierError("invalid identifier");
  }
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

function columnName(row) {
  return clean(row.source_column) || clean(row.field_key);
}

function isSearchable(row) {
  const kind = `${row.type || ""} ${row.input_kind || ""}`.toLowerCase();
  return !/(number|numeric|decimal|integer|float|date|time|bool|json)/.test(kind);
}

function normalizeField(row) {
  return {
    canonical_key: row.canonical_key,
    module_key: row.module_key,
    field_key: row.field_key,
    db_column: columnName(row),
    label: row.label,
    label_cn: row.label_cn,
    type: row.type,
    input_kind: row.input_kind,
    options_json: row.options_json,
    unit: row.unit,
    format: row.format,
    sort_order: Number(row.sort_order || 0),
    col_span: Math.max(1, Math.min(6, Number(row.col_span || 1))),
    section_key: row.section_key,
    section_label_cn: row.section_label_cn,
    tab: row.tab,
    searchable: isSearchable(row),
  };
}

async function validModule(pool, moduleKey) {
  if (!moduleKey || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(moduleKey)) return null;
  const result = await pool.query(
    `SELECT module_key
     FROM field_definitions
     WHERE module_key = $1
     GROUP BY module_key`,
    [moduleKey]
  );
  return result.rows[0]?.module_key || null;
}

async function tableColumns(pool, tableName) {
  quoteIdentifier(tableName);
  const result = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2`,
    ["public", tableName]
  );
  return new Set(result.rows.map(row => row.column_name));
}

async function loadFields(pool, moduleKey, columns) {
  const result = await pool.query(
    `SELECT canonical_key, module_key, field_key, label, label_cn, type, input_kind,
            options_json, unit, format, sort_order, col_span, section_key,
            section_label_cn, tab, source_column
     FROM field_definitions
     WHERE module_key = $1
       AND COALESCE(show_in_business, false) = true
       AND COALESCE(status, '') <> 'deprecated'
     ORDER BY COALESCE(sort_order, 0), field_key`,
    [moduleKey]
  );
  const seen = new Set();
  return result.rows
    .filter(row => {
      const name = columnName(row);
      if (!name || seen.has(name) || !columns.has(name)) return false;
      seen.add(name);
      return true;
    })
    .map(normalizeField);
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;

  const moduleKey = clean(req.query?.module);
  const pool = getPool();

  try {
    const allowed = await validModule(pool, moduleKey);
    if (!allowed) return res.status(400).json({ success: false, error: "Invalid module" });

    const columns = await tableColumns(pool, allowed);
    if (!columns.size) return res.status(400).json({ success: false, error: "Invalid module" });

    const fields = await loadFields(pool, allowed, columns);
    return res.json({
      success: true,
      module_key: allowed,
      generated_at: new Date().toISOString(),
      fields,
      column_count: fields.length,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
}
