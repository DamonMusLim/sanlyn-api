// /api/db/hy-grid-write - editable generic business grid field save
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

function parseBody(body) {
  if (!body) return {};
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  return body;
}

function userRole(req) {
  return clean(req.user?.role || req.user?.staff_role || req.user?.user_role);
}

function roleAllowed(requiredRoles, role) {
  const roles = Array.isArray(requiredRoles) ? requiredRoles.map(clean).filter(Boolean) : [];
  const allowed = roles.length ? roles : ["admin"];
  return { allowed, ok: allowed.includes(role) };
}

function requestIp(req) {
  const forwarded = clean(req.headers?.["x-forwarded-for"]);
  return clean(forwarded.split(",")[0] || req.socket?.remoteAddress);
}

function shortValue(value) {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function diffSummary(fields, before, after) {
  return fields
    .map(field => `${field}: ${shortValue(before[field])}->${shortValue(after[field])}`)
    .join("; ");
}

async function validModule(pool, moduleKey) {
  if (!moduleKey || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(moduleKey)) return null;
  const definitionResult = await pool.query(
    `SELECT module_key
     FROM field_definitions
     WHERE module_key = $1
     GROUP BY module_key`,
    [moduleKey]
  );
  const allowed = definitionResult.rows[0]?.module_key || null;
  if (!allowed) return null;

  const tableResult = await pool.query(
    `SELECT table_name, table_type
     FROM information_schema.tables
     WHERE table_schema = $1 AND table_name = $2
     LIMIT 1`,
    ["public", allowed]
  );
  const table = tableResult.rows[0];
  if (!table) return null;
  return { moduleKey: allowed, tableType: clean(table.table_type) };
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
  return null;
}

async function loadEditableFields(pool, moduleKey, columns) {
  const result = await pool.query(
    `SELECT field_key, source_column, editable_roles
     FROM field_definitions
     WHERE module_key = $1
       AND COALESCE(editable, false) = true
       AND COALESCE(input_kind, '') <> ''
       AND COALESCE(status, '') <> 'deprecated'
     ORDER BY COALESCE(sort_order, 0), field_key`,
    [moduleKey]
  );
  const fields = new Map();
  const seenColumns = new Set();
  for (const row of result.rows) {
    const key = clean(row.field_key);
    const dbColumn = columnName(row);
    if (!key || !dbColumn || !columns.has(dbColumn) || seenColumns.has(dbColumn)) continue;
    quoteIdentifier(key);
    quoteIdentifier(dbColumn);
    fields.set(key, { key, dbColumn, editableRoles: row.editable_roles });
    seenColumns.add(dbColumn);
  }
  return fields;
}

function auditIdentity(req) {
  return {
    operator: clean(req.user?.operator || req.user?.name || req.user?.email),
    role: userRole(req),
    company: clean(req.user?.company || req.user?.company_name),
    actorUserId: clean(req.user?.id || req.user?.user_id),
    actorStaffId: clean(req.user?.staff_id),
  };
}

async function insertAudit(pool, req, moduleKey, id, before, after, changedFields) {
  const actor = auditIdentity(req);
  const result = await pool.query(
    `INSERT INTO audit_logs (
       action, operator, role, company, detail, entity_type, entity_id,
       before, after, diff_summary, ip, user_agent, request_id,
       actor_type, actor_user_id, actor_staff_id, public_label, after_data
     )
     VALUES (
       $1, $2, $3, $4, $5::jsonb, $6, $7,
       $8::jsonb, $9::jsonb, $10, $11, $12, $13,
       $14, NULLIF($15, '')::uuid, NULLIF($16, '')::uuid, $17, $18::jsonb
     )
     RETURNING id`,
    [
      "hy_field_edit",
      actor.operator,
      actor.role,
      actor.company,
      JSON.stringify({ fields: changedFields }),
      moduleKey,
      String(id),
      JSON.stringify(before),
      JSON.stringify(after),
      diffSummary(changedFields, before, after),
      requestIp(req),
      clean(req.headers?.["user-agent"]),
      clean(req.headers?.["x-request-id"]),
      "human",
      actor.actorUserId,
      actor.actorStaffId,
      `${moduleKey}:${id}`,
      JSON.stringify(after),
    ]
  );
  return result.rows[0]?.id;
}

async function deleteAudit(pool, auditId) {
  if (!auditId) return;
  await pool.query(`DELETE FROM audit_logs WHERE id = $1`, [auditId]);
}

export default async function handler(req, res) {
  setCors(req, res, "PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "PATCH") return res.status(405).json({ success: false, error: "PATCH required" });
  if (!requireAuth(req, res)) return;

  const body = parseBody(req.body);
  if (!body) return res.status(400).json({ success: false, error: "Invalid JSON body" });

  const moduleKey = clean(body.module);
  const id = body.id;
  const changes = body.changes;
  if (id == null || !changes || Array.isArray(changes) || typeof changes !== "object") {
    return res.status(400).json({ success: false, error: "module, id and changes are required" });
  }

  const changedFields = Object.keys(changes);
  if (!changedFields.length) {
    return res.status(400).json({ success: false, error: "changes cannot be empty" });
  }

  const pool = getPool();

  try {
    const moduleInfo = await validModule(pool, moduleKey);
    if (!moduleInfo) return res.status(400).json({ success: false, error: "Invalid module" });
    if (moduleInfo.tableType !== "BASE TABLE") {
      return res.status(400).json({ success: false, error: "Views are not editable" });
    }

    const columns = await tableColumns(pool, moduleInfo.moduleKey);
    if (!columns.size) return res.status(400).json({ success: false, error: "Invalid module" });

    const pkColumn = await primaryKeyColumn(pool, moduleInfo.moduleKey, columns);
    if (!pkColumn) return res.status(400).json({ success: false, error: "Table has no editable primary key" });

    const editableFields = await loadEditableFields(pool, moduleInfo.moduleKey, columns);
    const rejected = changedFields.filter(field => !editableFields.has(field));
    if (rejected.length) {
      return res.status(400).json({
        success: false,
        error: "Fields are not editable",
        rejected_fields: rejected,
      });
    }

    const role = userRole(req);
    const denied = changedFields
      .map(field => ({ field, roles: roleAllowed(editableFields.get(field).editableRoles, role) }))
      .filter(item => !item.roles.ok);
    if (denied.length) {
      return res.status(403).json({
        success: false,
        error: "Role is not allowed to edit fields",
        denied_fields: denied.map(item => ({
          field: item.field,
          required_roles: item.roles.allowed,
        })),
      });
    }

    const tableSql = quoteIdentifier(moduleInfo.moduleKey);
    const pkSql = quoteIdentifier(pkColumn);
    const fieldSql = changedFields
      .map(field => `${quoteIdentifier(editableFields.get(field).dbColumn)} AS ${quoteIdentifier(field)}`)
      .join(", ");

    // Dynamic identifiers are safe here because module and columns were first validated
    // against field_definitions and information_schema, then quoted. Values stay parameterized.
    const beforeResult = await pool.query(`SELECT ${fieldSql} FROM ${tableSql} WHERE ${pkSql} = $1 LIMIT 1`, [id]);
    if (!beforeResult.rows[0]) return res.status(404).json({ success: false, error: "Row not found" });

    const before = beforeResult.rows[0];
    const after = Object.fromEntries(changedFields.map(field => [field, changes[field]]));
    let auditId = null;

    try {
      // No explicit transaction statements in this project. To avoid data changes without
      // accounting, insert audit first, then update the business table; if update fails,
      // delete the audit row we just inserted.
      auditId = await insertAudit(pool, req, moduleInfo.moduleKey, id, before, after, changedFields);
      const params = changedFields.map(field => changes[field]);
      params.push(id);
      const setSql = changedFields
        .map((field, index) => `${quoteIdentifier(editableFields.get(field).dbColumn)} = $${index + 1}`)
        .join(", ");
      const updateResult = await pool.query(
        `UPDATE ${tableSql} SET ${setSql} WHERE ${pkSql} = $${params.length}`,
        params
      );
      if (updateResult.rowCount !== 1) {
        await deleteAudit(pool, auditId);
        return res.status(404).json({ success: false, error: "Row not found" });
      }
      return res.json({ success: true, updated: changedFields.length, audit_id: auditId });
    } catch (err) {
      await deleteAudit(pool, auditId);
      throw err;
    }
  } catch (err) {
    console.error("[hy-grid-write]", err && err.message, err && err.stack && err.stack.split('\n')[1]);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
}
