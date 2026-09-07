// /api/db/hy-grid - read-only generic business grid data
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

class IdentifierError extends Error {}

function clean(value) {
  return value == null ? "" : String(value).trim();
}

function intRange(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
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

function searchable(row) {
  const kind = `${row.type || ""} ${row.input_kind || ""}`.toLowerCase();
  return !/(number|numeric|decimal|integer|float|date|time|bool|json)/.test(kind);
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

async function primaryKeyColumn(pool, tableName, columns) {
  quoteIdentifier(tableName);
  const result = await pool.query(
    `SELECT a.attname AS column_name
     FROM pg_constraint con
     JOIN pg_class c ON c.oid = con.conrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = con.conkey[1]
     WHERE n.nspname = $1
       AND c.relname = $2
       AND con.contype = 'p'
       AND array_length(con.conkey, 1) = 1
     LIMIT 1`,
    ["public", tableName]
  );
  const pk = clean(result.rows[0]?.column_name);
  if (pk && columns.has(pk)) {
    quoteIdentifier(pk);
    return pk;
  }
  if (columns.has("id")) return "id";
  return null;
}

async function loadFieldRows(pool, moduleKey, columns) {
  const result = await pool.query(
    `SELECT field_key, label, label_cn, type, input_kind, unit, format,
            sort_order, col_span, source_column,
            section_key, section_label_cn, section_order, editable
     FROM field_definitions
     WHERE module_key = $1
       AND COALESCE(show_in_business, false) = true
       AND COALESCE(status, '') <> 'deprecated'
     ORDER BY COALESCE(section_order, 999), COALESCE(sort_order, 0), field_key`,
    [moduleKey]
  );
  const seenColumns = new Set();
  const seenKeys = new Set();
  return result.rows.filter(row => {
    const dbColumn = columnName(row);
    const fieldKey = clean(row.field_key);
    if (!dbColumn || !fieldKey || seenColumns.has(dbColumn) || seenKeys.has(fieldKey)) return false;
    if (!columns.has(dbColumn)) return false;
    quoteIdentifier(dbColumn);
    quoteIdentifier(fieldKey);
    seenColumns.add(dbColumn);
    seenKeys.add(fieldKey);
    return true;
  });
}

function buildWhere(fields, q, params) {
  const keyword = clean(q);
  if (!keyword) return "";
  params.push(`%${keyword}%`);
  const marker = `$${params.length}`;
  const clauses = fields
    .filter(searchable)
    .map(field => `${quoteIdentifier(columnName(field))}::text ILIKE ${marker}`);
  return clauses.length ? `WHERE (${clauses.join(" OR ")})` : "";
}

async function loadRows(pool, moduleKey, fields, pkColumn, page, size, q) {
  const tableSql = quoteIdentifier(moduleKey);
  const params = [];
  const whereSql = buildWhere(fields, q, params);
  const fieldSelects = fields.map(field => `${quoteIdentifier(columnName(field))} AS ${quoteIdentifier(field.field_key)}`);
  const pkSelect = pkColumn ? `${quoteIdentifier(pkColumn)} AS ${quoteIdentifier("__pk")}` : "";
  const selectParts = pkSelect ? fieldSelects.concat(pkSelect) : fieldSelects;
  const selectSql = selectParts.length ? selectParts.join(", ") : "NULL AS empty_row";
  const orderSql = fields.length ? `ORDER BY ${quoteIdentifier(columnName(fields[0]))} NULLS LAST` : "";

  const countResult = await pool.query(`SELECT count(*) AS total FROM ${tableSql} ${whereSql}`, params);
  params.push(size);
  params.push((page - 1) * size);
  const dataResult = await pool.query(
    `SELECT ${selectSql}
     FROM ${tableSql}
     ${whereSql}
     ${orderSql}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    rows: selectParts.length ? dataResult.rows : [],
    total: Number(countResult.rows[0]?.total || 0),
  };
}

function responseFields(fields) {
  return fields.map(field => ({
    field_key: field.field_key,
    label: field.label,
    label_cn: field.label_cn,
    type: field.type,
    input_kind: field.input_kind,
    unit: field.unit,
    format: field.format,
    sort_order: Number(field.sort_order || 0),
    col_span: Math.max(1, Math.min(6, Number(field.col_span || 1))),
    searchable: searchable(field),
    // 前端抽屉依赖分区和可编辑标记；这里只透传字段定义，不改变原有字段语义。
    section_key: field.section_key,
    section_label_cn: field.section_label_cn,
    section_order: Number(field.section_order || 0),
    editable: field.editable === true,
  }));
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;

  const moduleKey = clean(req.query?.module);
  const page = intRange(req.query?.page, 1, 1, 100000);
  const size = intRange(req.query?.size, 50, 1, 200);
  const pool = getPool();

  try {
    const allowed = await validModule(pool, moduleKey);
    if (!allowed) return res.status(400).json({ success: false, error: "Invalid module" });

    const columns = await tableColumns(pool, allowed);
    if (!columns.size) return res.status(400).json({ success: false, error: "Invalid module" });

    const fields = await loadFieldRows(pool, allowed, columns);
    const pkColumn = await primaryKeyColumn(pool, allowed, columns);
    const data = await loadRows(pool, allowed, fields, pkColumn, page, size, req.query?.q);
    return res.json({
      success: true,
      module_key: allowed,
      generated_at: new Date().toISOString(),
      page,
      size,
      total: data.total,
      pk_field: pkColumn ? "__pk" : null,
      fields: responseFields(fields),
      rows: data.rows,
    });
  } catch (err) {
    console.error("[hy-grid]", err && err.message, err && err.stack && err.stack.split('\n')[1]);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
}
