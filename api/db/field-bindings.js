// /api/db/field-bindings  — active field binding map
// GET /api/db/field-bindings  (requires JWT)
//
// Returns: { success, generated_at, count, data: { [scope]: { [field_key]: binding_json } } }

import { getPool, setCors } from "../db.js";
import { requireAuth }      from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const pool = getPool();
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
