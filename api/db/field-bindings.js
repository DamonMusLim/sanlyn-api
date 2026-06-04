// /api/db/field-bindings  — active field binding map
// GET /api/db/field-bindings  (requires JWT)
//
// Returns: { success, generated_at, count, data: { [scope]: { [field_key]: binding_json } } }

import { getPool, setCors } from "../db.js";
import { requireAuth }      from "../auth.js";

const ALLOWED_SOURCE_TABLES = ["order_line_items", "products", "orders", "shipping_plans"];
const ALLOWED_SOURCE_COLUMNS = {
  order_line_items: ["cbm_ctn", "qty_ctn", "nw_ctn", "gw_ctn", "hs_code", "declaration_name", "declaration_elements", "tax_rebate_rate"],
  products: ["hs_code", "declaration_name", "declaration_elements", "tax_rebate_rate", "cbm_ctn", "nw_ctn", "gw_ctn"],
  orders: ["total_cbm", "total_qty", "net_weight", "gross_weight", "total_amount"],
  shipping_plans: ["bl_no", "container_qty"],
};
const ALLOWED_STRATEGIES = ["direct", "computed", "master_first", "constant"];
const ALLOWED_AGGS = ["sum_over_lines", "first", "max", "concat_distinct"];
const ALLOWED_FORMULA_FUNCTIONS = ["SUM", "MAPX", "IF", "ABS", "ROUND", "MIN", "MAX", "CONCATENATE"];

function trimRequiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    return { error: name + " required" };
  }
  return { value: value.trim() };
}

function trimOptionalString(value, name) {
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== "string") return { error: name + " must be a string" };
  if (!value.trim()) return { error: name + " required" };
  return { value: value.trim() };
}

function hasBalancedParens(value) {
  let depth = 0;
  for (const ch of value) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

function validateFormula(formula) {
  if (typeof formula !== "string" || !formula.trim()) return false;
  const trimmed = formula.trim();
  if (!/^[A-Za-z0-9_ .,*/+\-()"']+$/.test(trimmed)) return false;
  if (!hasBalancedParens(trimmed)) return false;
  const calls = trimmed.match(/\b[A-Za-z_][A-Za-z0-9_]*\s*\(/g) || [];
  return calls.every(call => ALLOWED_FORMULA_FUNCTIONS.includes(call.replace(/\s*\($/, "").toUpperCase()));
}

function validateSourcePair(sourceTable, sourceColumn) {
  if (sourceColumn && !sourceTable) return "source_column requires source_table";
  if (sourceTable && !ALLOWED_SOURCE_TABLES.includes(sourceTable)) return "source_table not allowed";
  if (sourceTable && sourceColumn && !ALLOWED_SOURCE_COLUMNS[sourceTable]?.includes(sourceColumn)) {
    return "source_column not allowed for source_table";
  }
  return null;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!requireAuth(req, res)) return;

  const pool = getPool();
  if (req.method === "PATCH") {
    const body = req.body || {};
    const { scope, field_key, binding, reason } = body;
    const trimmedScope = trimRequiredString(scope, "scope");
    const trimmedFieldKey = trimRequiredString(field_key, "field_key");
    if (trimmedScope.error || trimmedFieldKey.error || !binding || typeof binding !== "object" || Array.isArray(binding)) {
      return res.status(400).json({ success: false, error: "scope, field_key, and binding object required" });
    }
    const trimmedLabel = trimRequiredString(binding.label, "binding.label");
    if (trimmedLabel.error) {
      return res.status(400).json({ success: false, error: "binding.label required" });
    }
    const trimmedUnit = trimOptionalString(binding.unit, "binding.unit");
    if (trimmedUnit.error) return res.status(400).json({ success: false, error: trimmedUnit.error });
    const trimmedNote = trimOptionalString(binding.note, "binding.note");
    if (trimmedNote.error) return res.status(400).json({ success: false, error: trimmedNote.error });
    const trimmedReason = trimOptionalString(reason, "reason");
    if (trimmedReason.error) return res.status(400).json({ success: false, error: trimmedReason.error });
    if (!ALLOWED_STRATEGIES.includes(binding.strategy)) {
      return res.status(400).json({ success: false, error: "binding.strategy invalid" });
    }
    if (binding.agg != null && !ALLOWED_AGGS.includes(binding.agg)) {
      return res.status(400).json({ success: false, error: "binding.agg invalid" });
    }
    const sourceTable = typeof binding.source?.table === "string" ? binding.source.table.trim() : binding.source?.table;
    const sourceColumn = typeof binding.source?.column === "string" ? binding.source.column.trim() : binding.source?.column;
    if (sourceTable != null && typeof sourceTable !== "string") {
      return res.status(400).json({ success: false, error: "source_table must be a string" });
    }
    if (sourceColumn != null && typeof sourceColumn !== "string") {
      return res.status(400).json({ success: false, error: "source_column must be a string" });
    }
    if (sourceTable === "" || sourceColumn === "") {
      return res.status(400).json({ success: false, error: "source.table and source.column cannot be empty" });
    }
    const sourceError = validateSourcePair(sourceTable, sourceColumn);
    if (sourceError) return res.status(400).json({ success: false, error: sourceError });
    const hasValue = Object.prototype.hasOwnProperty.call(binding, "value");
    const formula = typeof binding.formula === "string" ? binding.formula.trim() : binding.formula;
    if (binding.strategy === "direct" || binding.strategy === "master_first") {
      if (!sourceTable || !sourceColumn) {
        return res.status(400).json({ success: false, error: "source.table and source.column required" });
      }
      if (binding.formula != null) {
        return res.status(400).json({ success: false, error: "formula not allowed for source strategy" });
      }
    }
    if (binding.strategy === "computed") {
      if (!validateFormula(formula)) {
        return res.status(400).json({ success: false, error: "binding.formula invalid" });
      }
      if (binding.agg != null) {
        return res.status(400).json({ success: false, error: "binding.agg incompatible with computed strategy" });
      }
    }
    if (binding.strategy === "constant") {
      if (!hasValue) {
        return res.status(400).json({ success: false, error: "binding.value required" });
      }
      if (sourceTable || sourceColumn || binding.formula != null) {
        return res.status(400).json({ success: false, error: "source and formula not allowed for constant strategy" });
      }
      if (binding.agg != null) {
        return res.status(400).json({ success: false, error: "binding.agg incompatible with constant strategy" });
      }
    }
    if (binding.strategy === "master_first" && binding.agg != null && binding.agg !== "first") {
      return res.status(400).json({ success: false, error: "binding.agg incompatible with master_first strategy" });
    }
    if (JSON.stringify(binding).length > 20000 || (trimmedReason.value && trimmedReason.value.length > 2000)) {
      return res.status(413).json({ success: false, error: "payload too large" });
    }

    const role = req.user.role;
    const operator = req.user.account || req.user.sub;
    let client;
    try {
      client = await pool.connect();
      await client.query("BEGIN");

      const fieldHistoryResult = await client.query(
        `SELECT binding_json, is_legal, status
         FROM field_bindings
         WHERE scope = $1 AND field_key = $2
         FOR UPDATE`,
        [trimmedScope.value, trimmedFieldKey.value]
      );
      const current = fieldHistoryResult.rows.find(row => row.status === "active") || null;
      const dbLegal = fieldHistoryResult.rows.length === 0
        ? true
        : fieldHistoryResult.rows.some(row => row.is_legal === true);
      const isLegal = dbLegal || binding.is_legal === true;
      const normalizedBinding = {
        ...binding,
        label: trimmedLabel.value,
        source: sourceTable || sourceColumn ? { ...(binding.source || {}), table: sourceTable, column: sourceColumn } : binding.source,
        formula: typeof formula === "string" ? formula : binding.formula,
        is_legal: isLegal,
      };
      if (Object.prototype.hasOwnProperty.call(binding, "unit")) normalizedBinding.unit = trimmedUnit.value;
      if (Object.prototype.hasOwnProperty.call(binding, "note")) normalizedBinding.note = trimmedNote.value;

      if (!["admin", "logistics", "sales"].includes(role)) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Forbidden", message: "权限不足" });
      }

      let targetStatus = "active";
      if (isLegal) {
        if (role === "sales") {
          await client.query("ROLLBACK");
          return res.status(403).json({ error: "Forbidden", message: "legal fields require admin approval" });
        }
        if (role === "logistics") targetStatus = "draft";
      }

      const versionResult = await client.query(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
         FROM field_bindings
         WHERE scope = $1 AND field_key = $2`,
        [trimmedScope.value, trimmedFieldKey.value]
      );
      const nextVersion = Number(versionResult.rows[0].next_version);

      // IRON RED LINE: this endpoint may ONLY write field_bindings and audit_logs.
      // It must NEVER update/insert orders, products, order_line_items, or any
      // other business table. Binding edits change DISPLAY mapping only, never
      // business truth for 报关/customs/legal data.
      if (targetStatus === "active") {
        await client.query(
          `UPDATE field_bindings
           SET status = $1
           WHERE scope = $2 AND field_key = $3 AND status = $4`,
          ["superseded", trimmedScope.value, trimmedFieldKey.value, "active"]
        );
      }

      await client.query(
        `INSERT INTO field_bindings (
           scope, field_key, label, source_strategy, source_table, source_column,
           formula, formula_human, agg, unit, is_legal, binding_json, status,
           version, note, created_by, updated_by
         )
         VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10, $11, $12::jsonb, $13,
           $14, $15, $16, $17
         )`,
        [
          trimmedScope.value,
          trimmedFieldKey.value,
          normalizedBinding.label,
          binding.strategy,
          sourceTable,
          sourceColumn,
          normalizedBinding.formula,
          binding.formula_human,
          binding.agg,
          normalizedBinding.unit,
          isLegal,
          JSON.stringify(normalizedBinding),
          targetStatus,
          nextVersion,
          normalizedBinding.note,
          operator,
          operator,
        ]
      );

      await client.query(
        `INSERT INTO audit_logs (action, operator, role, detail)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [
          "field_binding.update",
          operator,
          role,
          JSON.stringify({
            scope: trimmedScope.value,
            field_key: trimmedFieldKey.value,
            is_legal: isLegal,
            source_table: sourceTable || null,
            source_column: sourceColumn || null,
            strategy: binding.strategy,
            status: targetStatus,
            version: nextVersion,
            reason: trimmedReason.value,
            before: current ? { ...current.binding_json, is_legal: current.is_legal } : null,
            after: normalizedBinding,
          }),
        ]
      );

      await client.query("COMMIT");
      return res.status(200).json({
        success: true,
        status: targetStatus,
        version: nextVersion,
        data: normalizedBinding,
        message: targetStatus === "draft" ? "Submitted as draft pending approval" : "Field binding updated",
      });
    } catch (e) {
      if (client) await client.query("ROLLBACK").catch(function () {});
      console.error(e);
      if (e.code === "23505") {
        return res.status(409).json({ success: false, error: "concurrent update, retry" });
      }
      return res.status(500).json({ success: false, error: "internal error" });
    } finally {
      if (client) client.release();
    }
  }

  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const params = ["active"];
    let sql = `SELECT scope, field_key, binding_json, is_legal
               FROM field_bindings
               WHERE status = $1`;
    if (req.query?.scope) {
      params.push(String(req.query.scope).trim());
      sql += " AND scope = $2";
    }

    const r = await pool.query(sql, params);
    const data = {};
    r.rows.forEach(row => {
      if (!data[row.scope]) data[row.scope] = {};
      data[row.scope][row.field_key] = { ...row.binding_json, is_legal: row.is_legal };
    });

    res.json({ success: true, generated_at: new Date().toISOString(), count: r.rows.length, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}
