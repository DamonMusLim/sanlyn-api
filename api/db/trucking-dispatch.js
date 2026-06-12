// api/db/trucking-dispatch.js
// Handles both /api/db/drivers and /api/db/trucking-dispatch
// Spec: trucking-dispatch-spec.md (P2, 2026-04-30)

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// ── helpers ──────────────────────────────────────────────────────────────────
function json(res, status, body) {
  return res.status(status).json(body);
}

// ── drivers handlers ─────────────────────────────────────────────────────────

async function getDrivers(req, res) {
  const pool = getPool();
  const { q } = req.query;
  let sql, vals;
  if (q && q.trim()) {
    const like = `%${q.trim()}%`;
    sql = `SELECT * FROM drivers
           WHERE is_active = true
             AND (name ILIKE $1 OR phone ILIKE $1)
           ORDER BY created_at DESC
           LIMIT 100`;
    vals = [like];
  } else {
    sql = `SELECT * FROM drivers WHERE is_active = true ORDER BY created_at DESC LIMIT 200`;
    vals = [];
  }
  const result = await pool.query(sql, vals);
  return json(res, 200, { success: true, data: result.rows });
}

async function createDriver(req, res) {
  const pool = getPool();
  const { name, phone, id_card_no, truck_plate, trucking_co,
          photo_url, license_url, notes } = req.body;
  if (!name || !phone) {
    return json(res, 400, { success: false, error: "name and phone are required" });
  }
  const sql = `
    INSERT INTO drivers (name, phone, id_card_no, truck_plate, trucking_co,
                         photo_url, license_url, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING *`;
  const vals = [name, phone, id_card_no||null, truck_plate||null, trucking_co||null,
                photo_url||null, license_url||null, notes||null];
  const result = await pool.query(sql, vals);
  return json(res, 201, { success: true, data: result.rows[0] });
}

async function updateDriver(req, res, id) {
  const pool = getPool();
  const allowed = ["name","phone","id_card_no","truck_plate","trucking_co",
                   "photo_url","license_url","notes","is_active"];
  const sets = [], vals = [];
  for (const key of allowed) {
    if (key in req.body) {
      sets.push(`${key} = $${vals.length + 1}`);
      vals.push(req.body[key]);
    }
  }
  if (!sets.length) return json(res, 400, { success: false, error: "no fields to update" });
  sets.push(`updated_at = NOW()`);
  vals.push(id);
  const sql = `UPDATE drivers SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`;
  const result = await pool.query(sql, vals);
  if (!result.rows.length) return json(res, 404, { success: false, error: "driver not found" });
  return json(res, 200, { success: true, data: result.rows[0] });
}

async function deleteDriver(req, res, id) {
  // Soft-delete: is_active = false
  const pool = getPool();
  const result = await pool.query(
    `UPDATE drivers SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING id`,
    [id]
  );
  if (!result.rows.length) return json(res, 404, { success: false, error: "driver not found" });
  return json(res, 200, { success: true, data: { id } });
}

// ── trucking_dispatches handlers ──────────────────────────────────────────────

async function getDispatches(req, res) {
  const pool = getPool();
  const { order_no, bl_no, driver_id } = req.query;
  const conds = [], vals = [];
  if (order_no) { conds.push(`td.order_no = $${vals.length+1}`); vals.push(order_no); }
  if (bl_no)    { conds.push(`td.bl_no    = $${vals.length+1}`); vals.push(bl_no); }
  if (driver_id){ conds.push(`td.driver_id = $${vals.length+1}`); vals.push(driver_id); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const sql = `
    SELECT td.*,
           d.name       AS driver_name,
           d.phone      AS driver_phone,
           d.photo_url  AS driver_photo_url,
           d.trucking_co AS driver_trucking_co
    FROM   trucking_dispatches td
    LEFT JOIN drivers d ON d.id = td.driver_id
    ${where}
    ORDER BY td.created_at DESC
    LIMIT 200`;
  const result = await pool.query(sql, vals);
  return json(res, 200, { success: true, data: result.rows });
}

async function createDispatch(req, res) {
  const pool = getPool();
  const {
    order_no, container_no, container_no_2, seal_no, container_type, container_weight_kg,
    driver_id, truck_plate, trucking_co,
    loading_time, loading_addr, pickup_depot, drop_depot,
    bl_no, status, photos, notes,
    tow_type, quote_amount, quote_note
  } = req.body;

  const sql = `
    INSERT INTO trucking_dispatches
      (order_no, container_no, container_no_2, seal_no, container_type, container_weight_kg,
       driver_id, truck_plate, trucking_co,
       loading_time, loading_addr, pickup_depot, drop_depot,
       bl_no, status, photos, notes,
       tow_type, quote_amount, quote_note)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
    RETURNING *`;
  const vals = [
    order_no||null, container_no||null, container_no_2||null, seal_no||null,
    container_type||null, container_weight_kg||null,
    driver_id||null, truck_plate||null, trucking_co||null,
    loading_time||null, loading_addr||null,
    pickup_depot||null, drop_depot||null,
    bl_no||null, status||"pending",
    photos ? JSON.stringify(photos) : "[]",
    notes||null,
    tow_type||null,
    quote_amount ? parseFloat(quote_amount) : null,
    quote_note||null
  ];
  const result = await pool.query(sql, vals);
  return json(res, 201, { success: true, data: result.rows[0] });
}

async function updateDispatch(req, res, id) {
  const pool = getPool();
  const allowed = [
    "order_no","container_no","container_no_2","seal_no","container_type","container_weight_kg",
    "driver_id","truck_plate","trucking_co",
    "loading_time","loading_addr","pickup_depot","drop_depot",
    "bl_no","status","notes",
    "tow_type","quote_amount","quote_note"
  ];
  const sets = [], vals = [];
  for (const key of allowed) {
    if (key in req.body) {
      sets.push(`${key} = $${vals.length + 1}`);
      vals.push(req.body[key]);
    }
  }
  // photos is JSONB — handle separately
  if ("photos" in req.body) {
    sets.push(`photos = $${vals.length + 1}`);
    vals.push(JSON.stringify(req.body.photos));
  }
  if (!sets.length) return json(res, 400, { success: false, error: "no fields to update" });
  sets.push(`updated_at = NOW()`);
  vals.push(id);
  const sql = `UPDATE trucking_dispatches SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`;
  const result = await pool.query(sql, vals);
  if (!result.rows.length) return json(res, 404, { success: false, error: "dispatch not found" });
  return json(res, 200, { success: true, data: result.rows[0] });
}

// ── main router ───────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const path = req.path || "";

  // ── /api/db/drivers ──────────────────────────────────────
  if (path.startsWith("/api/db/drivers")) {
    // Extract :id if present — path like /api/db/drivers/uuid
    const parts = path.split("/").filter(Boolean); // ["api","db","drivers","<id?>"]
    const id = parts[3] || null;
    try {
      if (!id) {
        if (req.method === "GET")  return await getDrivers(req, res);
        if (req.method === "POST") return await createDriver(req, res);
      } else {
        if (req.method === "PATCH")  return await updateDriver(req, res, id);
        if (req.method === "DELETE") return await deleteDriver(req, res, id);
      }
      return json(res, 405, { success: false, error: "method not allowed" });
    } catch (err) {
      console.error("[drivers]", err);
      return json(res, 500, { success: false, error: err.message });
    }
  }

  // ── /api/db/trucking-dispatch ────────────────────────────
  if (path.startsWith("/api/db/trucking-dispatch")) {
    const parts = path.split("/").filter(Boolean); // ["api","db","trucking-dispatch","<id?>"]
    const id = parts[3] || null;
    try {
      if (!id) {
        if (req.method === "GET")  return await getDispatches(req, res);
        if (req.method === "POST") return await createDispatch(req, res);
      } else {
        if (req.method === "PATCH") return await updateDispatch(req, res, id);
      }
      return json(res, 405, { success: false, error: "method not allowed" });
    } catch (err) {
      console.error("[trucking-dispatch]", err);
      return json(res, 500, { success: false, error: err.message });
    }
  }

  return json(res, 404, { success: false, error: "not found" });
}
