// /api/db/field-layout — persisted FieldDesigner layout
// GET/PATCH/POST /api/db/field-layout  (requires JWT)

import { getPool, setCors } from "../db.js";
import { requireAuth }      from "../auth.js";

const ALLOWED_MODULES = new Set(["shipping_plans","orders","products","order_line_items","companies","customers","countries","ports","container_bookings","customs","manifest"]);

function validModuleKey(value) {
  const moduleKey = value == null ? "" : String(value).trim();
  return ALLOWED_MODULES.has(moduleKey) ? moduleKey : null;
}

function validLayoutJson(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function validateChildModules(layoutJson) {
  if (!Object.prototype.hasOwnProperty.call(layoutJson, "child_modules")) return null;
  if (!Array.isArray(layoutJson.child_modules)) return "child_modules must be an array";

  for (let i = 0; i < layoutJson.child_modules.length; i += 1) {
    const module = layoutJson.child_modules[i];
    if (!module || typeof module !== "object" || Array.isArray(module)) {
      return `child_modules[${i}] must be an object`;
    }
    for (const field of ["key", "table", "parent_key", "columns"]) {
      if (!Object.prototype.hasOwnProperty.call(module, field)) {
        return `child_modules[${i}].${field} required`;
      }
    }
    if (!Array.isArray(module.columns)) {
      return `child_modules[${i}].columns must be an array`;
    }
    for (let j = 0; j < module.columns.length; j += 1) {
      const column = module.columns[j];
      if (!column || typeof column !== "object" || Array.isArray(column)) {
        return `child_modules[${i}].columns[${j}] must be an object`;
      }
      for (const field of ["field", "label"]) {
        if (!Object.prototype.hasOwnProperty.call(column, field)) {
          return `child_modules[${i}].columns[${j}].${field} required`;
        }
      }
    }
  }
  return null;
}

function mergeLayoutJson(existingLayout, nextLayout) {
  if (!validLayoutJson(existingLayout)) return nextLayout;
  const merged = {
    ...existingLayout,
    ...nextLayout,
  };
  if (Object.prototype.hasOwnProperty.call(nextLayout, "child_modules")) {
    merged.child_modules = nextLayout.child_modules;
  } else if (Object.prototype.hasOwnProperty.call(existingLayout, "child_modules")) {
    merged.child_modules = existingLayout.child_modules;
  }
  return merged;
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
        `SELECT layout_json
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
      const childModuleError = validateChildModules(layoutJson);
      if (childModuleError) {
        return res.status(400).json({ success: false, error: childModuleError });
      }

      const updatedBy = req.user.account || req.user.sub;
      const existingResult = await pool.query(
        `SELECT layout_json
         FROM field_layouts
         WHERE module_key = $1
           AND version = 1
           AND status = 'active'
         LIMIT 1`,
        [moduleKey]
      );
      const mergedLayoutJson = mergeLayoutJson(existingResult.rows[0]?.layout_json, layoutJson);
      const updateResult = await pool.query(
        `UPDATE field_layouts
         SET layout_json = $2,
             updated_by = $3,
             updated_at = now()
         WHERE module_key = $1
           AND version = 1
           AND status = 'active'`,
        [moduleKey, mergedLayoutJson, updatedBy]
      );

      if (updateResult.rowCount === 0) {
        await pool.query(
          `INSERT INTO field_layouts (module_key, version, layout_json, status, updated_by)
           VALUES ($1, 1, $2, 'active', $3)`,
          [moduleKey, mergedLayoutJson, updatedBy]
        );
      }

      return res.json({ success: true });
    }
  } catch (e) {
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
}
