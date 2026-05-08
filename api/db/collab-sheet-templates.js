// GET /api/db/collab-sheet-templates?sheet_type=X
// Returns template config (fields_schema, role_tabs, file_taxonomy) for a sheet type.
import { getPool, setCors } from "../db.js";
import { roleFromAuth, sendError } from "../lib/viewmodel-adapter.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return sendError(res, 405, "method_not_allowed");

  const { sheet_type } = req.query || {};
  const pool = getPool();

  try {
    if (sheet_type) {
      const r = await pool.query(
        "SELECT * FROM collab_sheet_templates WHERE sheet_type = $1 LIMIT 1",
        [sheet_type]
      );
      if (!r.rows.length) return sendError(res, 404, "template_not_found");
      return res.status(200).json({ data: r.rows[0] });
    }
    // No filter: return all templates
    const r = await pool.query("SELECT * FROM collab_sheet_templates ORDER BY sheet_type");
    return res.status(200).json({ data: r.rows });
  } catch (err) {
    console.error("[collab-sheet-templates]", err);
    return sendError(res, 500, "internal_error", err.message);
  }
}
