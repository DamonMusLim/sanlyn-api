// /api/db/field-bindings  — active field binding map
// GET /api/db/field-bindings  (requires JWT)
//
// Returns: { success, generated_at, count, data: { [scope]: { [field_key]: binding_json } } }

import { getPool, setCors } from "../db.js";
import { requireAuth }      from "../auth.js";

const ALLOWED_SOURCE_TABLES = ["order_line_items", "products", "orders", "shipping_plans"];
const ALLOWED_STRATEGIES = ["direct", "computed", "master_first", "constant"];
const ALLOWED_AGGS = ["sum_over_lines", "first", "max", "concat_distinct"];

export default async function handler(req, res) {
  setCors(req, res, "GET, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!requireAuth(req, res)) return;

  const pool = getPool();
  if (req.method === "PATCH") {
    const body = req.body || {};
    const { scope, field_key, binding, reason } = body;
    if (typeof scope !== "string" || !scope.trim() || typeof field_key !== "string" || !field_key.trim() || !binding || typeof binding !== "object" || Array.isArray(binding)) {
      return res.status(400).json({ success: false, error: "scope, field_key, and binding object required" });
    }
    if (typeof binding.label !== "string" || !binding.label.trim()) {
      return res.status(400).json({ success: false, error: "binding.label required" });
    }
    if (!ALLOWED_STRATEGIES.includes(binding.strategy)) {
      return res.status(400).json({ success: false, error: "binding.strategy invalid" });
    }
    if (binding.agg != null && !ALLOWED_AGGS.includes(binding.agg)) {
      return res.status(400).json({ success: false, error: "binding.agg invalid" });
    }
    if (reason !== undefined && typeof reason !== "string") {
      return res.status(400).json({ success: false, error: "reason must be a string" });
    }
    const sourceTable = binding.source?.table;
    if (sourceTable != null && !ALLOWED_SOURCE_TABLES.includes(sourceTable)) {
      return res.status(400).json({ success: false, error: "source_table not allowed" });
    }
    if (JSON.stringify(binding).length > 20000 || (reason && String(reason).length > 2000)) {
      return res.status(413).json({ success: false, error: "payload too large" });
    }

    let legalResult;
    try {
      legalResult = await pool.query(
        `SELECT bool_or(is_legal) AS is_legal
         FROM field_bindings
         WHERE scope = $1 AND field_key = $2`,
        [scope, field_key]
      );
    } catch (e) {
      console.error(e);
      return res.status(500).json({ success: false, error: "internal error" });
    }
    const dbLegal = legalResult.rows[0]?.is_legal == null ? true : legalResult.rows[0].is_legal;
    const isLegal = dbLegal || binding.is_legal === true;

    const role = req.user.role;
    if (!["admin", "logistics", "sales"].includes(role)) {
      return res.status(403).json({ error: "Forbidden", message: "权限不足" });
    }

    const operator = req.user.account || req.user.sub;
    let client;
    try {
      client = await pool.connect();
      await client.query("BEGIN");

      const currentResult = await client.query(
        `SELECT binding_json, is_legal
         FROM field_bindings
         WHERE scope = $1 AND field_key = $2 AND status = $3
         LIMIT 1
         FOR UPDATE`,
        [scope, field_key, "active"]
      );
      const current = currentResult.rows[0] || null;

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
        [scope, field_key]
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
          ["superseded", scope, field_key, "active"]
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
          scope,
          field_key,
          binding.label,
          binding.strategy,
          binding.source?.table,
          binding.source?.column,
          binding.formula,
          binding.formula_human,
          binding.agg,
          binding.unit,
          isLegal,
          JSON.stringify(binding),
          targetStatus,
          nextVersion,
          binding.note,
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
            scope,
            field_key,
            status: targetStatus,
            version: nextVersion,
            reason: reason || null,
            before: current ? current.binding_json : null,
            after: binding,
          }),
        ]
      );

      await client.query("COMMIT");
      return res.status(200).json({
        success: true,
        status: targetStatus,
        version: nextVersion,
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
    let sql = `SELECT scope, field_key, binding_json
               FROM field_bindings
               WHERE status = $1`;
    if (req.query?.scope) {
      params.push(req.query.scope);
      sql += " AND scope = $2";
    }

    const r = await pool.query(sql, params);
    const data = {};
    r.rows.forEach(row => {
      if (!data[row.scope]) data[row.scope] = {};
      data[row.scope][row.field_key] = row.binding_json;
    });

    res.json({ success: true, generated_at: new Date().toISOString(), count: r.rows.length, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}
