// /api/db/hy-modules - read-only module catalog for generic HY grids
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function rowToModule(row) {
  return {
    module_key: row.module_key,
    field_count: toInt(row.field_count),
    visible_field_count: toInt(row.visible_field_count),
    estimated_rows: toInt(row.estimated_rows),
  };
}

async function loadModules(pool) {
  const result = await pool.query(
    `WITH defs AS (
       SELECT module_key,
              count(*) AS field_count,
              count(*) FILTER (
                WHERE COALESCE(show_in_business, false) = true
                  AND COALESCE(status, '') <> 'deprecated'
              ) AS visible_field_count
       FROM field_definitions
       WHERE domain IN ('freight','finance','master') AND module_key ~ '^[A-Za-z_][A-Za-z0-9_]*$'
       GROUP BY module_key
     )
     SELECT defs.module_key,
            defs.field_count,
            defs.visible_field_count,
            COALESCE(NULLIF(pg_class.reltuples, -1), 0) AS estimated_rows
     FROM defs
     LEFT JOIN pg_namespace
       ON pg_namespace.nspname = 'public'
     LEFT JOIN pg_class
       ON pg_class.relnamespace = pg_namespace.oid
      AND pg_class.relname = defs.module_key
      AND pg_class.relkind IN ('r', 'p', 'v', 'm', 'f')
     ORDER BY estimated_rows DESC, defs.module_key`
  );
  return result.rows.map(rowToModule);
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;

  try {
    const modules = await loadModules(getPool());
    return res.json({
      success: true,
      generated_at: new Date().toISOString(),
      modules,
    });
  } catch (err) {
    console.error("[hy-modules]", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
}
