// /api/db/field-catalog/resolve - read-only field relation resolver
// GET /api/db/field-catalog/resolve?relation_key=&parent_id=  (requires JWT)

import { getPool, setCors } from "../db.js";
import { requireAuth }      from "../auth.js";

const ALLOWED_TABLES = new Set(["orders", "order_line_items", "products", "shipping_plans", "companies", "customs"]);

class IdentifierError extends Error {}

function isTrue(value) {
  return value === true || value === "true";
}

function trimRequired(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function primaryKeyFor(moduleKey) {
  return moduleKey === "shipping_plans" ? "_id" : "id";
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

function publicRelation(row) {
  return {
    relation_key: row.relation_key,
    relation_type: row.relation_type,
    from_module: row.from_module,
    from_field_key: row.from_field_key,
    to_module: row.to_module,
    to_field_key: row.to_field_key,
    role_key: row.role_key,
    label: row.label,
    cardinality: row.cardinality,
  };
}

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

function noRelatedResponse(relation, parent, generatedAt) {
  return {
    success: true,
    generated_at: generatedAt,
    relation: publicRelation(relation),
    parent,
    related: null,
    lookups: [],
  };
}

async function loadParent(pool, columns, moduleKey, parentId) {
  const tableSql = verifyTable(columns, moduleKey);
  const pk = primaryKeyFor(moduleKey);
  const pkSql = verifyColumn(columns, moduleKey, pk);
  const result = await pool.query(
    `SELECT *
     FROM ${tableSql}
     WHERE ${pkSql} = $1
     LIMIT 1`,
    [parentId]
  );
  return result.rows[0] || null;
}

async function loadFkRelated(pool, columns, relation, matchValue) {
  const tableSql = verifyTable(columns, relation.to_module);
  const fieldSql = verifyColumn(columns, relation.to_module, relation.to_field_key);
  const orderBy = hasColumn(columns, relation.to_module, "id") ? `ORDER BY ${quoteIdentifier("id")} DESC NULLS LAST` : "";
  const result = await pool.query(
    `SELECT *
     FROM ${tableSql}
     WHERE ${fieldSql} = $1
     ${orderBy}
     LIMIT 1`,
    [matchValue]
  );
  return result.rows[0] || null;
}

async function loadLogicalRelated(pool, columns, relation, matchValue) {
  const tableSql = verifyTable(columns, relation.to_module);
  const fieldSql = verifyColumn(columns, relation.to_module, relation.to_field_key);
  const orderParts = [`BTRIM(${fieldSql}::text)`];

  if (hasColumn(columns, relation.to_module, "status")) {
    orderParts.push(`(${quoteIdentifier("status")} = 'active') DESC NULLS LAST`);
  }
  if (hasColumn(columns, relation.to_module, "is_deprecated")) {
    orderParts.push(`${quoteIdentifier("is_deprecated")} ASC NULLS FIRST`);
  } else if (hasColumn(columns, relation.to_module, "status")) {
    orderParts.push(`(${quoteIdentifier("status")} IN ('deprecated', 'inactive')) ASC NULLS FIRST`);
  }
  if (hasColumn(columns, relation.to_module, "updated_at")) {
    orderParts.push(`${quoteIdentifier("updated_at")} DESC NULLS LAST`);
  }
  if (hasColumn(columns, relation.to_module, "id")) {
    orderParts.push(`${quoteIdentifier("id")} DESC NULLS LAST`);
  }

  const result = await pool.query(
    `SELECT DISTINCT ON (BTRIM(${fieldSql}::text)) *
     FROM ${tableSql}
     WHERE NULLIF(BTRIM(${fieldSql}::text), '') IS NOT NULL
       AND BTRIM(${fieldSql}::text) = BTRIM($1::text)
     ORDER BY ${orderParts.join(", ")}
     LIMIT 1`,
    [matchValue]
  );
  return result.rows[0] || null;
}

async function loadChildren(pool, columns, relation, matchValue) {
  const tableSql = verifyTable(columns, relation.to_module);
  const fieldSql = verifyColumn(columns, relation.to_module, relation.to_field_key);
  const orderBy = hasColumn(columns, relation.to_module, "id") ? `ORDER BY ${quoteIdentifier("id")} ASC NULLS LAST` : "";
  const result = await pool.query(
    `SELECT *
     FROM ${tableSql}
     WHERE ${fieldSql} = $1
     ${orderBy}`,
    [matchValue]
  );
  return result.rows;
}

async function loadLookups(pool, relationKey, includeInactive) {
  const params = [relationKey];
  const where = ["relation_key = $1"];
  if (!includeInactive) {
    params.push("active");
    where.push(`status = $${params.length}`);
  }
  const result = await pool.query(
    `SELECT
       lookup_key,
       related_module,
       target_field_key,
       related_field_key,
       mode,
       is_readonly,
       status
     FROM field_lookups
     WHERE ${where.join(" AND ")}
     ORDER BY lookup_key`,
    params
  );
  return result.rows;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const relationKey = trimRequired(req.query?.relation_key);
  const parentId = trimRequired(req.query?.parent_id);
  if (!relationKey || !parentId) {
    return res.status(400).json({ success: false, error: "relation_key and parent_id required" });
  }

  const pool = getPool();
  const includeInactive = isTrue(req.query?.include_inactive);
  const generatedAt = new Date().toISOString();

  try {
    const relationParams = [relationKey];
    const relationWhere = ["relation_key = $1"];
    if (!includeInactive) {
      relationParams.push("active");
      relationWhere.push(`status = $${relationParams.length}`);
    }

    const relationResult = await pool.query(
      `SELECT
         relation_key,
         from_module,
         from_field_key,
         to_module,
         to_field_key,
         relation_type,
         role_key,
         label,
         cardinality,
         status
       FROM field_relations
       WHERE ${relationWhere.join(" AND ")}
       LIMIT 1`,
      relationParams
    );
    const relation = relationResult.rows[0];
    if (!relation) {
      return res.status(404).json({ success: false, error: "relation not found" });
    }

    const columns = await loadColumns(pool, new Set([relation.from_module, relation.to_module]));
    verifyColumn(columns, relation.from_module, relation.from_field_key);
    verifyColumn(columns, relation.to_module, relation.to_field_key);
    verifyColumn(columns, relation.from_module, primaryKeyFor(relation.from_module));

    const parentRecord = await loadParent(pool, columns, relation.from_module, parentId);
    const parentMatchValue = parentRecord ? parentRecord[relation.from_field_key] : null;
    const parent = {
      module_key: relation.from_module,
      id: parentId,
      match_value: parentMatchValue == null ? null : String(parentMatchValue),
    };

    if (!parentRecord || isBlank(parentMatchValue)) {
      return res.json(noRelatedResponse(relation, parent, generatedAt));
    }

    if (relation.relation_type === "subform") {
      const children = await loadChildren(pool, columns, relation, parentMatchValue);
      return res.json({
        success: true,
        generated_at: generatedAt,
        relation: publicRelation(relation),
        parent,
        children: {
          module_key: relation.to_module,
          records: children,
          count: children.length,
        },
        lookups: [],
      });
    }

    let relatedRecord = null;
    if (relation.relation_type === "fk") {
      relatedRecord = await loadFkRelated(pool, columns, relation, parentMatchValue);
    } else if (relation.relation_type === "logical") {
      relatedRecord = await loadLogicalRelated(pool, columns, relation, parentMatchValue);
    } else {
      throw new IdentifierError("unsupported relation type");
    }

    if (!relatedRecord) {
      return res.json(noRelatedResponse(relation, parent, generatedAt));
    }

    const lookups = await loadLookups(pool, relation.relation_key, includeInactive);
    for (const lookup of lookups) {
      if (lookup.related_module !== relation.to_module) {
        throw new IdentifierError("lookup module mismatch");
      }
      verifyColumn(columns, lookup.related_module, lookup.related_field_key);
    }
    return res.json({
      success: true,
      generated_at: generatedAt,
      relation: publicRelation(relation),
      parent,
      related: {
        module_key: relation.to_module,
        record: relatedRecord,
        match_value: relatedRecord[relation.to_field_key] == null ? null : String(relatedRecord[relation.to_field_key]),
      },
      lookups: lookups.map(lookup => ({
        lookup_key: lookup.lookup_key,
        target_field_key: lookup.target_field_key,
        related_field_key: lookup.related_field_key,
        mode: lookup.mode,
        is_readonly: lookup.is_readonly,
        value: relatedRecord[lookup.related_field_key],
      })),
    });
  } catch (e) {
    if (e instanceof IdentifierError) {
      return res.status(500).json({ success: false, error: "Internal server error" });
    }
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
}
