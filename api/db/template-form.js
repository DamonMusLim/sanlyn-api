// /api/db/template-form - read-only template form preview
// GET /api/db/template-form?module_key=products&record_id=<id|sku>&state=business|edit  (requires JWT)

import { getPool, setCors } from "../db.js";
import { requireAuth }      from "../auth.js";

const ALLOWED_TABLES = new Set(["orders", "order_line_items", "products", "shipping_plans", "companies", "customs"]);

class IdentifierError extends Error {}

function trimRequired(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function quoteIdentifier(identifier) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new IdentifierError("invalid identifier");
  }
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

async function loadColumns(pool, tableNames) {
  const result = await pool.query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = $1
       AND table_name = ANY($2::text[])`,
    ["public", Array.from(tableNames)]
  );
  const columns = new Map();
  for (const row of result.rows) {
    if (!columns.has(row.table_name)) columns.set(row.table_name, new Set());
    columns.get(row.table_name).add(row.column_name);
  }
  return columns;
}

function verifyTable(columns, tableName) {
  if (!ALLOWED_TABLES.has(tableName) || !columns.has(tableName)) {
    throw new IdentifierError("invalid table");
  }
  return quoteIdentifier(tableName);
}

function verifyColumn(columns, tableName, columnName) {
  verifyTable(columns, tableName);
  if (!columns.get(tableName).has(columnName)) {
    throw new IdentifierError("invalid column");
  }
  return quoteIdentifier(columnName);
}

function hasColumn(columns, tableName, columnName) {
  return ALLOWED_TABLES.has(tableName) && columns.get(tableName)?.has(columnName) === true;
}

function hasCatalogColumn(catalogColumns, columnName) {
  return catalogColumns.get("field_definitions")?.has(columnName) === true;
}

function catalogExpr(catalogColumns, columnName, fallbackSql = "NULL") {
  return hasCatalogColumn(catalogColumns, columnName)
    ? `fd.${quoteIdentifier(columnName)}`
    : fallbackSql;
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch (_e) {
    return fallback;
  }
}

function jsonArray(value, fallback) {
  const parsed = parseJson(value, fallback);
  return Array.isArray(parsed) ? parsed : fallback;
}

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

function fillRate(nonEmpty, total) {
  if (!total) return 0;
  return Number((nonEmpty / total).toFixed(4));
}

function fieldColumn(row) {
  return row.db_column || row.source_column || row.field_key;
}

function fieldLabel(row) {
  return row.label || row.label_en || row.field_key;
}

function fieldType(row) {
  return row.input_kind || row.type || "text";
}

async function loadFieldRows(pool, moduleKey, state, catalogColumns) {
  const params = [moduleKey];
  const where = ["fd.module_key = $1"];
  if (state === "business" && hasCatalogColumn(catalogColumns, "show_in_business")) {
    where.push("COALESCE(fd.show_in_business, true) = true");
  }

  const result = await pool.query(
    `SELECT
       ${catalogExpr(catalogColumns, "canonical_key")} AS canonical_key,
       fd.module_key,
       fd.field_key,
       ${catalogExpr(catalogColumns, "db_column", catalogExpr(catalogColumns, "source_column", "fd.field_key"))} AS db_column,
       ${catalogExpr(catalogColumns, "label")} AS label,
       ${catalogExpr(catalogColumns, "label_en")} AS label_en,
       ${catalogExpr(catalogColumns, "label_cn")} AS label_cn,
       ${catalogExpr(catalogColumns, "type")} AS type,
       ${catalogExpr(catalogColumns, "input_kind")} AS input_kind,
       ${catalogExpr(catalogColumns, "tab", "'product'")} AS tab,
       ${catalogExpr(catalogColumns, "section_key", "'default'")} AS section_key,
       ${catalogExpr(catalogColumns, "section_label")} AS section_label,
       ${catalogExpr(catalogColumns, "section_label_cn")} AS section_label_cn,
       ${catalogExpr(catalogColumns, "section_order", "0")} AS section_order,
       ${catalogExpr(catalogColumns, "sort_order", "0")} AS sort_order,
       ${catalogExpr(catalogColumns, "editable", "true")} AS editable,
       ${catalogExpr(catalogColumns, "visible_roles", `'["admin","factory","logistics","customer"]'::jsonb`)} AS visible_roles,
       ${catalogExpr(catalogColumns, "editable_roles", `'["admin"]'::jsonb`)} AS editable_roles,
       ${catalogExpr(catalogColumns, "col_span", "1")} AS col_span,
       ${catalogExpr(catalogColumns, "options_json")} AS options_json,
       ${catalogExpr(catalogColumns, "show_in_business", "true")} AS show_in_business,
       ${catalogExpr(catalogColumns, "show_in_edit", "true")} AS show_in_edit,
       ${catalogExpr(catalogColumns, "required_for_completeness", "false")} AS required_for_completeness,
       ${catalogExpr(catalogColumns, "source_kind")} AS source_kind,
       ${catalogExpr(catalogColumns, "source_table")} AS source_table,
       ${catalogExpr(catalogColumns, "source_column")} AS source_column,
       ${catalogExpr(catalogColumns, "relationship_json", "'{}'::jsonb")} AS relationship_json
     FROM field_definitions fd
     WHERE ${where.join(" AND ")}
     ORDER BY
       COALESCE(${catalogExpr(catalogColumns, "section_order", "0")}, 0),
       COALESCE(${catalogExpr(catalogColumns, "sort_order", "0")}, 0),
       fd.field_key`,
    params
  );
  return result.rows;
}

async function loadReferenceMaps(pool, moduleKey) {
  const [lookupResult, relationResult] = await Promise.all([
    pool.query(
      `SELECT target_field_key AS field_key
       FROM field_lookups
       WHERE module_key = $1
       GROUP BY target_field_key`,
      [moduleKey]
    ),
    pool.query(
      `SELECT from_field_key AS field_key
       FROM field_relations
       WHERE from_module = $1
       UNION
       SELECT to_field_key AS field_key
       FROM field_relations
       WHERE to_module = $1`,
      [moduleKey]
    ),
  ]);
  return {
    lookupFields: new Set(lookupResult.rows.map(row => row.field_key)),
    relationFields: new Set(relationResult.rows.map(row => row.field_key)),
  };
}

async function loadRecord(pool, columns, moduleKey, recordId) {
  const tableSql = verifyTable(columns, moduleKey);
  const predicates = [];
  if (hasColumn(columns, moduleKey, "id")) {
    predicates.push(`${verifyColumn(columns, moduleKey, "id")}::text = $1`);
  }
  if (hasColumn(columns, moduleKey, "sku")) {
    predicates.push(`${verifyColumn(columns, moduleKey, "sku")}::text = $1`);
  }
  if (!predicates.length) return null;

  const result = await pool.query(
    `SELECT *
     FROM ${tableSql}
     WHERE ${predicates.join(" OR ")}
     LIMIT 1`,
    [recordId]
  );
  return result.rows[0] || null;
}

async function loadStats(pool, columns, moduleKey, fields) {
  const tableSql = verifyTable(columns, moduleKey);
  const validFields = [];
  const seen = new Set();

  for (const field of fields) {
    const columnName = fieldColumn(field);
    if (!columnName || seen.has(columnName)) continue;
    verifyColumn(columns, moduleKey, columnName);
    seen.add(columnName);
    validFields.push({ columnName, columnSql: quoteIdentifier(columnName), alias: `f${validFields.length}` });
  }

  const aggregates = validFields.map(
    field => `count(${field.columnSql}) FILTER (WHERE ${field.columnSql} IS NOT NULL AND btrim(${field.columnSql}::text) <> '') AS ${quoteIdentifier(field.alias)}`
  );
  const result = await pool.query(
    `SELECT count(*) AS total${aggregates.length ? ", " + aggregates.join(", ") : ""}
     FROM ${tableSql}`
  );
  const row = result.rows[0] || {};
  const total = Number(row.total || 0);
  const statsByColumn = new Map();
  for (const field of validFields) {
    const nonEmpty = Number(row[field.alias] || 0);
    statsByColumn.set(field.columnName, {
      non_empty_count: nonEmpty,
      total_count: total,
      fill_rate: fillRate(nonEmpty, total),
    });
  }
  return { total, statsByColumn };
}

function fieldReference(row) {
  const relationship = parseJson(row.relationship_json, {});
  return relationship?.reference || null;
}

function buildTemplate({ moduleKey, state, fields, record, statsByColumn, total, lookupFields, relationFields }) {
  const tabs = [];
  const tabMap = new Map();

  for (const row of fields) {
    const columnName = fieldColumn(row);
    const relationship = parseJson(row.relationship_json, {});
    const reference = relationship?.reference || null;
    const hasReference =
      !!reference ||
      row.source_kind === "lookup" ||
      lookupFields.has(row.field_key) ||
      relationFields.has(row.field_key);
    const stats = statsByColumn.get(columnName) || {
      non_empty_count: 0,
      total_count: total,
      fill_rate: 0,
    };
    const noData = stats.non_empty_count === 0;
    const value = record && columnName && Object.prototype.hasOwnProperty.call(record, columnName)
      ? record[columnName]
      : null;
    const tabId = row.tab || "product";
    const sectionKey = row.section_key || "default";

    if (!tabMap.has(tabId)) {
      const tab = { id: tabId, label: tabId, sections: [], _sectionMap: new Map() };
      tabMap.set(tabId, tab);
      tabs.push(tab);
    }
    const tab = tabMap.get(tabId);
    if (!tab._sectionMap.has(sectionKey)) {
      const section = {
        key: sectionKey,
        label: row.section_label || sectionKey,
        label_cn: row.section_label_cn || null,
        grid_cols: Math.max(1, Math.min(4, Number(row.grid_cols || 2))),
        fields: [],
      };
      tab._sectionMap.set(sectionKey, section);
      tab.sections.push(section);
    }

    const field = {
      field_key: row.field_key,
      db_column: columnName,
      label: fieldLabel(row),
      label_cn: row.label_cn,
      type: row.type || "text",
      input_kind: fieldType(row),
      editable: row.editable !== false,
      visible_roles: jsonArray(row.visible_roles, ["admin", "factory", "logistics", "customer"]),
      editable_roles: jsonArray(row.editable_roles, ["admin"]),
      show_in_business: row.show_in_business !== false,
      show_in_edit: row.show_in_edit !== false,
      required_for_completeness: row.required_for_completeness === true,
      sort_order: Number(row.sort_order || 0),
      col_span: Math.max(1, Math.min(4, Number(row.col_span || 1))),
      options_json: parseJson(row.options_json, null),
      value,
      reference: fieldReference(row),
    };

    if (state === "edit") {
      field.provenance = {
        purpose: row.label_cn || row.label || row.field_key,
        source: row.source_table && row.source_column
          ? `${row.source_table}.${row.source_column}`
          : `${moduleKey}.${columnName}`,
        empty_reason: isBlank(value) ? "当前记录为空" : "",
      };
      field.stats = stats;
      field.flags = {
        has_reference: hasReference,
        no_data: noData,
        redundant_candidate: !hasReference && noData,
      };
    }

    tab._sectionMap.get(sectionKey).fields.push(field);
  }

  for (const tab of tabs) {
    delete tab._sectionMap;
  }
  return { tabs };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const moduleKey = trimRequired(req.query?.module_key);
  const recordId = trimRequired(req.query?.record_id);
  const state = trimRequired(req.query?.state) || "business";

  if (!moduleKey || !recordId) {
    return res.status(400).json({ success: false, error: "module_key and record_id required" });
  }
  if (state !== "business" && state !== "edit") {
    return res.status(400).json({ success: false, error: "state must be business or edit" });
  }

  const pool = getPool();

  try {
    const columns = await loadColumns(pool, new Set([moduleKey]));
    verifyTable(columns, moduleKey);
    const catalogColumns = await loadColumns(pool, new Set(["field_definitions"]));
    const allFields = await loadFieldRows(pool, moduleKey, state, catalogColumns);
    // REVIEW-HARDENING (Claude): skip field_definitions rows whose column is not a real table column
    // (products has 71 defs but 67 columns -> derived defs would throw 500). Filter instead of verify-throw.
    const fields = allFields.filter((field) => hasColumn(columns, moduleKey, fieldColumn(field)));

    const [record, referenceMaps, stats] = await Promise.all([
      loadRecord(pool, columns, moduleKey, recordId),
      loadReferenceMaps(pool, moduleKey),
      loadStats(pool, columns, moduleKey, fields),
    ]);

    res.json({
      success: true,
      generated_at: new Date().toISOString(),
      module_key: moduleKey,
      state,
      record,
      template: buildTemplate({
        moduleKey,
        state,
        fields,
        record,
        statsByColumn: stats.statsByColumn,
        total: stats.total,
        lookupFields: referenceMaps.lookupFields,
        relationFields: referenceMaps.relationFields,
      }),
    });
  } catch (e) {
    if (e instanceof IdentifierError) {
      return res.status(500).json({ success: false, error: "Internal server error" });
    }
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
}
