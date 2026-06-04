// /api/db/field-catalog  — canonical field catalog with active binding resolution
// GET /api/db/field-catalog  (requires JWT)

import { getPool, setCors } from "../db.js";
import { requireAuth }      from "../auth.js";

const MODULE_ORDER = ["orders", "order_line_items", "products", "shipping_plans", "companies", "customs", "shipping", "finance"];

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
      COALESCE(fd.customs_relevant, fd.is_legal) AS customs_relevant,
      fd.source_kind AS definition_source_kind,
      fd.source_table AS definition_source_table,
      fd.source_column AS definition_source_column,
      fd.is_system_derived,
      fd.is_curated,
      fd.stale_risk,
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
    const includeInactive = isTrue(req.query?.include_inactive);
    const moduleFilter = req.query?.module ? String(req.query.module).trim() : null;
    const moduleMap = new Map();
    const fieldMap = new Map();

    for (const moduleKey of MODULE_ORDER) {
      moduleMap.set(moduleKey, { module_key: moduleKey, fields: [], relations: [], subforms: [] });
    }

    for (const row of r.rows) {
      if (!moduleMap.has(row.module_key)) {
        moduleMap.set(row.module_key, { module_key: row.module_key, fields: [], relations: [], subforms: [] });
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
        customs_relevant: row.customs_relevant,
        source_kind: row.definition_source_kind,
        source_table: row.definition_source_table,
        source_column: row.definition_source_column,
        is_system_derived: row.is_system_derived,
        is_curated: row.is_curated,
        stale_risk: row.stale_risk,
        grain: row.grain,
        relationship: row.relationship_json || {},
        validation: row.validation_json || {},
        status: row.status,
        binding: null,
        compat: null,
        lookups: [],
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
      fieldMap.set(`${row.module_key}.${row.field_key}`, field);
    }

    const relationParams = [];
    const relationWhere = [];
    if (!includeInactive) {
      relationParams.push("active");
      relationWhere.push(`status = $${relationParams.length}`);
    }
    if (moduleFilter) {
      relationParams.push(moduleFilter);
      relationWhere.push(`(from_module = $${relationParams.length} OR to_module = $${relationParams.length})`);
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
         resolution_json,
         status
       FROM field_relations
       ${relationWhere.length ? "WHERE " + relationWhere.join(" AND ") : ""}
       ORDER BY relation_key`,
      relationParams
    );

    for (const row of relationResult.rows) {
      const targetModules = new Set([row.from_module, row.to_module]);
      for (const moduleKey of targetModules) {
        if (!moduleMap.has(moduleKey)) continue;
        const direction = row.from_module === moduleKey && row.to_module === moduleKey
          ? "self"
          : row.from_module === moduleKey
            ? "outbound"
            : "inbound";
        moduleMap.get(moduleKey).relations.push({
          relation_key: row.relation_key,
          from_module: row.from_module,
          from_field_key: row.from_field_key,
          to_module: row.to_module,
          to_field_key: row.to_field_key,
          relation_type: row.relation_type,
          role_key: row.role_key,
          label: row.label,
          cardinality: row.cardinality,
          direction,
          resolution: row.resolution_json || {},
          status: row.status,
        });
      }

      if (row.relation_type === "subform" && moduleMap.has(row.from_module)) {
        moduleMap.get(row.from_module).subforms.push({
          relation_key: row.relation_key,
          module_key: row.to_module,
          role_key: row.role_key,
          label: row.label,
          parent_module: row.from_module,
          parent_field_key: row.from_field_key,
          child_module: row.to_module,
          child_field_key: row.to_field_key,
          cardinality: row.cardinality,
          status: row.status,
        });
      }
    }

    const lookupParams = [];
    const lookupWhere = [];
    if (!includeInactive) {
      lookupParams.push("active");
      lookupWhere.push(`status = $${lookupParams.length}`);
    }
    if (moduleFilter) {
      lookupParams.push(moduleFilter);
      lookupWhere.push(`module_key = $${lookupParams.length}`);
    }
    const lookupResult = await pool.query(
      `SELECT
         lookup_key,
         module_key,
         target_field_key,
         relation_key,
         related_module,
         related_field_key,
         mode,
         is_readonly,
         status
       FROM field_lookups
       ${lookupWhere.length ? "WHERE " + lookupWhere.join(" AND ") : ""}
       ORDER BY lookup_key`,
      lookupParams
    );

    for (const row of lookupResult.rows) {
      const field = fieldMap.get(`${row.module_key}.${row.target_field_key}`);
      if (!field) continue;
      field.lookups.push({
        lookup_key: row.lookup_key,
        relation_key: row.relation_key,
        related_module: row.related_module,
        related_field_key: row.related_field_key,
        mode: row.mode,
        is_readonly: row.is_readonly,
        status: row.status,
      });
    }

    const modules = Array.from(moduleMap.values()).filter(module => module.fields.length > 0);
    res.json({
      success: true,
      generated_at: new Date().toISOString(),
      count: r.rows.length,
      relation_count: relationResult.rows.length,
      lookup_count: lookupResult.rows.length,
      modules,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}
