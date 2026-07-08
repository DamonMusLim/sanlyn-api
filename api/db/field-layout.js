// /api/db/field-layout — persisted FieldDesigner layout
// GET/PATCH/POST /api/db/field-layout  (requires JWT)

import { getPool, setCors } from "../db.js";
import { requireAuth }      from "../auth.js";

const ALLOWED_MODULES = new Set(["shipping_plans","orders","products","order_line_items","companies","customers","countries","ports","container_bookings","customs"]);

function validModuleKey(value) {
  const moduleKey = value == null ? "" : String(value).trim();
  return ALLOWED_MODULES.has(moduleKey) ? moduleKey : null;
}

function validLayoutJson(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function writeModuleKey(req) {
  if (req.body?.module_key !== undefined) return validModuleKey(req.body.module_key);
  if (req.query?.module_key !== undefined) return validModuleKey(req.query.module_key);
  return "shipping_plans";
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!requireAuth(req, res)) return;

  try {
    if (!["GET", "POST", "PATCH"].includes(req.method)) {
      return res.status(405).json({ error: "GET only" });
    }

    const pool = getPool();

    if (req.method === "GET") {
      const moduleKey = validModuleKey(req.query?.module_key);
      if (!moduleKey) return res.status(400).json({ success: false, error: "Invalid module_key" });

      const result = await pool.query(
        `SELECT layout_json, updated_at, updated_by, version
         FROM field_layouts
         WHERE module_key = $1
           AND status = 'active'
         ORDER BY version DESC, updated_at DESC
         LIMIT 1`,
        [moduleKey]
      );

      return res.json({
        success: true,
        module_key: moduleKey,
        layout_json: result.rows[0]?.layout_json ?? null,
        updated_at: result.rows[0]?.updated_at ?? null,
        updated_by: result.rows[0]?.updated_by ?? null,
        version: result.rows[0]?.version ?? null,
      });
    }

    if (req.method === "POST" || req.method === "PATCH") {
      const role=req.user.role;
      if(!["admin","logistics"].includes(role)) return res.status(403).json({error:"Forbidden",message:"权限不足"});

      const moduleKey = writeModuleKey(req);
      if (!moduleKey) return res.status(400).json({ success: false, error: "Invalid module_key" });

      const layoutJson = req.body?.layout_json;
      if (!validLayoutJson(layoutJson)) {
        return res.status(400).json({ success: false, error: "layout_json object required" });
      }

      const updatedBy = req.user?.username || req.user?.uid;
      const updateResult = await pool.query(
        `UPDATE field_layouts
         SET layout_json = $2,
             updated_by = $3,
             updated_at = now()
         WHERE module_key = $1
           AND version = 1
           AND status = 'active'
         RETURNING module_key, version, updated_at, updated_by`,
        [moduleKey, layoutJson, updatedBy]
      );

      let row = updateResult.rows[0];
      if (updateResult.rowCount === 0) {
        const insertResult = await pool.query(
          `INSERT INTO field_layouts (module_key, version, layout_json, status, updated_by)
           VALUES ($1, 1, $2, 'active', $3)
           RETURNING module_key, version, updated_at, updated_by`,
          [moduleKey, layoutJson, updatedBy]
        );
        row = insertResult.rows[0];
      }

      return res.json({
        success: true,
        module_key: row.module_key,
        version: row.version,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
      });
    }
  } catch (e) {
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
}

/*
Change log:
- L37-L58: GET now returns layout audit metadata already stored in field_layouts.
- L73-L103: PATCH/POST writes req.user username/uid, RETURNING saved audit fields in success JSON.
*/
