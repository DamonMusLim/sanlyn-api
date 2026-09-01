// /api/db/hy-module-status - read-only HY module wiring status
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

function rowToStatus(row) {
  return {
    menu_group: row.menu_group,
    leaf_key: row.leaf_key,
    module_cn: row.module_cn,
    hgj_route: row.hgj_route,
    our_table: row.our_table,
    our_module_key: row.our_module_key,
    state: row.state,
    note: row.note,
  };
}

async function loadModuleStatus(pool) {
  const result = await pool.query(
    `SELECT menu_group,
            leaf_key,
            module_cn,
            hgj_route,
            our_table,
            our_module_key,
            state,
            note
       FROM hy_module_status
      ORDER BY menu_group, module_cn`
  );
  return result.rows.map(rowToStatus);
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;

  try {
    const modules = await loadModuleStatus(getPool());
    return res.json({
      success: true,
      generated_at: new Date().toISOString(),
      modules,
    });
  } catch (err) {
    console.error("[hy-module-status]", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
}
