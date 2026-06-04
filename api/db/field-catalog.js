// /api/db/field-catalog  — canonical field catalog with active binding resolution
// GET /api/db/field-catalog  (requires JWT)

import { getPool, setCors } from "../db.js";
import { requireAuth }      from "../auth.js";

const MODULE_ORDER = ["orders", "products", "order_line_items", "customs", "shipping", "finance"];

function isTrue(value) {
  return value === true || value === "true";
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const pool = getPool();
  const params = [];
  const where = [];

  if (!isTrue(req.query?.include_inactive)) {
    params.push("active");
    where.push(`fd.status = $${params.length}`);
  }

  if (req.query?.module) {
    params.push(String(req.query.module).trim());
    where.push(`fd.module_key = $${params.length}`);
  }

  const sql = `
    WITH ranked_bindings AS (
      SELECT
        fb.*,
        ROW_NUMBER() OVER (
          PARTITION BY fb.canonical_key
          ORDER BY fb.version DESC, fb.updated_at DESC NULLS LAST, fb.id DESC
        ) AS rn
      FROM field_bindings fb
      WHERE fb.status = $${params.length + 1}
        AND fb.canonical_key IS NOT NULL
    )
    SELECT
      fd.canonical_key,
      fd.module_key,
      fd.field_key,
      fd.label,
      fd.type,
      fd.unit,
      fd.format,
      fd.is_legal,
      fd.grain,
      fd.relationship_json,
      fd.validation_json,
      fd.status,
      rb.id AS binding_id,
      rb.scope AS binding_scope,
      rb.field_key AS binding_field_key,
      rb.label AS binding_label,
      rb.source_strategy,
      rb.source_table,
      rb.source_column,
      rb.formula,
      rb.formula_human,
      rb.agg,
      rb.unit AS binding_unit,
      rb.is_legal AS binding_is_legal,
      rb.binding_json,
      rb.status AS binding_status,
      rb.version AS binding_version
    FROM field_definitions fd
    LEFT JOIN ranked_bindings rb
      ON rb.canonical_key = fd.canonical_key
     AND rb.rn = 1
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY
      array_position($${params.length + 2}::text[], fd.module_key),
      fd.module_key,
      fd.field_key`;

  try {
    const r = await pool.query(sql, [...params, "active", MODULE_ORDER]);
    const moduleMap = new Map();

    for (const moduleKey of MODULE_ORDER) {
      moduleMap.set(moduleKey, { module_key: moduleKey, fields: [] });
    }

    for (const row of r.rows) {
      if (!moduleMap.has(row.module_key)) {
        moduleMap.set(row.module_key, { module_key: row.module_key, fields: [] });
      }

      const field = {
        canonical_key: row.canonical_key,
        module_key: row.module_key,
        field_key: row.field_key,
        label: row.label,
        type: row.type,
        unit: row.unit,
        format: row.format || {},
        is_legal: row.is_legal,
        grain: row.grain,
        relationship: row.relationship_json || {},
        validation: row.validation_json || {},
        status: row.status,
        binding: null,
        compat: null,
      };

      if (row.binding_id != null) {
        field.binding = {
          id: row.binding_id,
          scope: row.binding_scope,
          field_key: row.binding_field_key,
          label: row.binding_label,
          source_strategy: row.source_strategy,
          source_table: row.source_table,
          source_column: row.source_column,
          formula: row.formula,
          formula_human: row.formula_human,
          agg: row.agg,
          unit: row.binding_unit,
          is_legal: row.binding_is_legal,
          binding_json: row.binding_json || {},
          status: row.binding_status,
          version: row.binding_version,
        };
        field.compat = {
          legacy_scope: row.binding_scope,
          legacy_field_key: row.binding_field_key,
        };
      }

      moduleMap.get(row.module_key).fields.push(field);
    }

    const modules = Array.from(moduleMap.values()).filter(module => module.fields.length > 0);
    res.json({ success: true, generated_at: new Date().toISOString(), count: r.rows.length, modules });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}
