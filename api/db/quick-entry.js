import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const ALLOWED_TABLES = new Set(["service_rates", "shipping_plans", "orders", "products", "order_line_items", "companies", "customers", "customs"]);
const ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

class BadRequest extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function clean(v) {
  return String(v ?? "").trim();
}

function qid(v) {
  if (!ID_RE.test(v)) throw new BadRequest("invalid identifier");
  return `"${v.replace(/"/g, '""')}"`;
}

function parseJson(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

function jsonArray(v, fallback) {
  const parsed = parseJson(v, fallback);
  return Array.isArray(parsed) ? parsed : fallback;
}

function roleAllowed(list, role) {
  const arr = jsonArray(list, []);
  return !arr.length || arr.includes(role) || arr.includes("*");
}

function fieldColumn(row) {
  return clean(row.source_column || row.field_key);
}

function fieldTable(row, moduleKey) {
  return clean(row.source_table || moduleKey);
}

async function columnsFor(pool, tables) {
  const result = await pool.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])`,
    [Array.from(tables)]
  );
  const out = new Map();
  for (const row of result.rows) {
    if (!out.has(row.table_name)) out.set(row.table_name, new Set());
    out.get(row.table_name).add(row.column_name);
  }
  return out;
}

async function catalogColumns(pool) {
  return columnsFor(pool, new Set(["field_definitions", "field_layouts"]));
}

function hasCol(columns, table, column) {
  return columns.get(table)?.has(column) === true;
}

function catExpr(cols, column, fallback = "NULL") {
  return hasCol(cols, "field_definitions", column) ? `fd.${qid(column)}` : fallback;
}

async function loadDefinitions(pool, moduleKey, role) {
  const cat = await catalogColumns(pool);
  const result = await pool.query(
    `SELECT
       ${catExpr(cat, "canonical_key")} AS canonical_key,
       fd.module_key, fd.field_key,
       ${catExpr(cat, "label")} AS label,
       ${catExpr(cat, "label_cn")} AS label_cn,
       ${catExpr(cat, "type", "'text'")} AS type,
       ${catExpr(cat, "unit")} AS unit,
       ${catExpr(cat, "format")} AS format,
       ${catExpr(cat, "input_kind", "'text'")} AS input_kind,
       ${catExpr(cat, "options_json")} AS options_json,
       ${catExpr(cat, "validation_json")} AS validation_json,
       ${catExpr(cat, "relationship_json")} AS relationship_json,
       ${catExpr(cat, "section_key", "'default'")} AS section_key,
       ${catExpr(cat, "section_label")} AS section_label,
       ${catExpr(cat, "section_label_cn")} AS section_label_cn,
       ${catExpr(cat, "section_order", "0")} AS section_order,
       ${catExpr(cat, "sort_order", "0")} AS sort_order,
       ${catExpr(cat, "editable", "true")} AS editable,
       ${catExpr(cat, "visible_roles", "'[]'::jsonb")} AS visible_roles,
       ${catExpr(cat, "editable_roles", "'[]'::jsonb")} AS editable_roles,
       ${catExpr(cat, "col_span", "1")} AS col_span,
       ${catExpr(cat, "source_kind")} AS source_kind,
       ${catExpr(cat, "source_table")} AS source_table,
       ${catExpr(cat, "source_column")} AS source_column,
       ${catExpr(cat, "is_system_derived", "false")} AS is_system_derived,
       ${catExpr(cat, "show_in_edit", "true")} AS show_in_edit,
       ${catExpr(cat, "required_for_completeness", "false")} AS required_for_completeness,
       ${catExpr(cat, "status", "'active'")} AS status
     FROM field_definitions fd
     WHERE fd.module_key = $1
       AND COALESCE(${catExpr(cat, "status", "'active'")}, 'active') = 'active'
     ORDER BY COALESCE(${catExpr(cat, "section_order", "0")}, 0),
              COALESCE(${catExpr(cat, "sort_order", "0")}, 0),
              fd.field_key`,
    [moduleKey]
  );
  const wantedTables = new Set([moduleKey]);
  result.rows.forEach((row) => wantedTables.add(fieldTable(row, moduleKey)));
  const tableCols = await columnsFor(pool, wantedTables);
  const fields = result.rows
    .filter((row) => clean(row.canonical_key) && row.show_in_edit !== false)
    .filter((row) => roleAllowed(row.visible_roles, role))
    .map((row) => ({
      ...row,
      canonical_key: clean(row.canonical_key),
      db_table: fieldTable(row, moduleKey),
      db_column: fieldColumn(row),
      options_json: parseJson(row.options_json, null),
      validation_json: parseJson(row.validation_json, {}),
      relationship_json: parseJson(row.relationship_json, {}),
      visible_roles: jsonArray(row.visible_roles, []),
      editable_roles: jsonArray(row.editable_roles, []),
      editable: row.editable !== false && roleAllowed(row.editable_roles, role),
      required_for_completeness: row.required_for_completeness === true,
      col_span: Math.max(1, Math.min(4, Number(row.col_span || 1))),
    }))
    .filter((row) => ALLOWED_TABLES.has(row.db_table) && hasCol(tableCols, row.db_table, row.db_column));
  return { fields, tableCols };
}

async function loadLayout(pool, moduleKey) {
  const result = await pool.query(
    `SELECT layout_json
       FROM field_layouts
      WHERE module_key = $1 AND status = 'active'
      ORDER BY version DESC, updated_at DESC
      LIMIT 1`,
    [moduleKey]
  ).catch(() => ({ rows: [] }));
  return result.rows[0]?.layout_json || null;
}

function buildSections(fields, layout) {
  const byField = new Map(fields.map((field) => [field.field_key, field]));
  const seen = new Set();
  const sections = [];
  if (Array.isArray(layout?.sections)) {
    for (const sec of layout.sections) {
      const items = (sec.fields || []).map((key) => byField.get(key)).filter(Boolean);
      items.forEach((f) => seen.add(f.field_key));
      if (items.length) sections.push({ key: sec.key || sec.section_key || "default", label: sec.label || sec.section_label || sec.key || "default", fields: items });
    }
  }
  for (const field of fields) {
    if (seen.has(field.field_key)) continue;
    let sec = sections.find((s) => s.key === field.section_key);
    if (!sec) {
      sec = { key: field.section_key || "default", label: field.section_label_cn || field.section_label || field.section_key || "默认", fields: [] };
      sections.push(sec);
    }
    sec.fields.push(field);
  }
  return sections;
}

function applyLayoutProps(fields, layout) {
  const props = layout?.props && typeof layout.props === "object" ? layout.props : {};
  return fields.map((field) => {
    const prop = props[field.field_key] || props[field.canonical_key] || {};
    const relationship = { ...(field.relationship_json || {}) };
    if (prop.reference && !relationship.reference) relationship.reference = prop.reference;
    return {
      ...field,
      label: prop.label || field.label,
      label_cn: prop.label_cn || field.label_cn,
      input_kind: prop.input_kind || field.input_kind,
      options_json: prop.options_json || prop.options || field.options_json,
      validation_json: prop.validation_json || field.validation_json,
      relationship_json: prop.relationship_json || relationship,
      col_span: prop.col_span ? Math.max(1, Math.min(4, Number(prop.col_span))) : field.col_span,
      editable: prop.editable === false ? false : field.editable,
    };
  });
}

function normalizeValue(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return value;
}

function validateFields(fields, values) {
  const errors = [];
  const required = fields.filter((f) => f.required_for_completeness).slice(0, 2);
  for (const field of required) {
    const v = normalizeValue(values[field.canonical_key]);
    if (v == null) errors.push(`${field.canonical_key} required`);
  }
  for (const field of fields) {
    const v = normalizeValue(values[field.canonical_key]);
    const rule = field.validation_json || {};
    if (v == null) continue;
    if (rule.pattern && !(new RegExp(rule.pattern).test(String(v)))) errors.push(`${field.canonical_key} format`);
    if (field.input_kind === "number" || rule.min != null || rule.max != null) {
      const n = Number(v);
      if (!Number.isFinite(n)) errors.push(`${field.canonical_key} number`);
      if (rule.min != null && n < Number(rule.min)) errors.push(`${field.canonical_key} min`);
      if (rule.max != null && n > Number(rule.max)) errors.push(`${field.canonical_key} max`);
    }
  }
  return { errors, enforced_required: required.map((f) => f.canonical_key) };
}

async function writeEntry(pool, moduleKey, fields, tableCols, rawValues, recordId, actor) {
  const table = fields[0]?.db_table || moduleKey;
  if (!ALLOWED_TABLES.has(table) || fields.some((f) => f.db_table !== table)) throw new BadRequest("module maps to multiple tables");
  const editable = fields.filter((f) => f.editable && !f.is_system_derived);
  const values = {};
  for (const field of editable) {
    const v = normalizeValue(rawValues[field.canonical_key]);
    values[field.canonical_key] = v ?? null;
  }
  const candidates = editable.filter((f) => normalizeValue(rawValues[f.canonical_key]) != null);
  if (!candidates.length) throw new BadRequest("no values to write");
  const cols = candidates.map((f) => f.db_column);
  const params = candidates.map((f) => normalizeValue(rawValues[f.canonical_key]));
  if (recordId) {
    const idCol = hasCol(tableCols, table, "id") ? "id" : "_id";
    if (!hasCol(tableCols, table, idCol)) throw new BadRequest("table has no editable record id");
    params.push(clean(recordId));
    const sets = cols.map((c, i) => `${qid(c)} = $${i + 1}`);
    const sql = `UPDATE ${qid(table)} SET ${sets.join(", ")} WHERE ${qid(idCol)}::text = $${params.length} RETURNING *`;
    const result = await pool.query(sql, params);
    if (!result.rowCount) throw new BadRequest("record not found", 404);
    return { action: "update", row: result.rows[0], payload: values };
  }
  if (fields.some((f) => f.db_column === "created_by")) {
    cols.push("created_by");
    params.push(actor);
  }
  const placeholders = params.map((_, i) => `$${i + 1}`);
  const sql = `INSERT INTO ${qid(table)} (${cols.map(qid).join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`;
  const result = await pool.query(sql, params);
  return { action: "insert", row: result.rows[0], payload: values };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ error: "Method not allowed" });
  const moduleKey = clean(req.query?.module_key || req.query?.module || req.body?.module_key);
  if (!moduleKey || !ID_RE.test(moduleKey)) return res.status(400).json({ success: false, error: "module_key required" });
  const role = req.user?.role || "";
  try {
    const pool = getPool();
    const [definition, layout] = await Promise.all([loadDefinitions(pool, moduleKey, role), loadLayout(pool, moduleKey)]);
    const { tableCols } = definition;
    const fields = applyLayoutProps(definition.fields, layout);
    if (req.method === "GET") {
      return res.json({ success: true, configured: fields.length > 0, module_key: moduleKey, role, layout_json: layout, sections: buildSections(fields, layout), generated_at: new Date().toISOString() });
    }
    if (!fields.length) throw new BadRequest("module has no configured field_definitions", 404);
    const values = req.body?.values && typeof req.body.values === "object" ? req.body.values : {};
    const validation = validateFields(fields, values);
    if (validation.errors.length) return res.status(400).json({ success: false, errors: validation.errors, enforced_required: validation.enforced_required });
    const actor = req.user?.account || req.user?.email || req.user?.sub || "unknown";
    const written = await writeEntry(pool, moduleKey, fields, tableCols, values, req.body?.record_id, actor);
    return res.json({ success: true, module_key: moduleKey, action: written.action, id: written.row?.id || written.row?._id || null, payload_by_canonical_key: written.payload, row: written.row });
  } catch (err) {
    if (err instanceof BadRequest) return res.status(err.status).json({ success: false, error: err.message });
    console.error("[quick-entry]", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
}
