// /api/db/customs-shipment-containers.js
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const WRITE_ROLES = new Set(["admin", "logistics"]);
const READ_ROLES = new Set(["admin", "logistics", "sales", "ops", "finance"]);
const ALLOWED_PATCH = [
  "container_no", "seal_no", "container_type", "truck_no", "driver_name",
  "driver_tel", "load_location", "pickup_location", "port_location",
  "white_card_no", "tare_kg",
];

function fail(res, status, error) {
  return res.status(status).json({ success: false, error });
}

function canRead(user) {
  return READ_ROLES.has(user?.role) || WRITE_ROLES.has(user?.role);
}

function canWrite(user) {
  return WRITE_ROLES.has(user?.role);
}

async function shipmentExists(pool, id) {
  const r = await pool.query("SELECT 1 FROM customs_shipments WHERE id = $1 LIMIT 1", [id]);
  return r.rowCount > 0;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const pool = getPool();

  if (req.method === "GET") {
    if (!canRead(req.user)) return fail(res, 403, "Forbidden");
    try {
      const shipmentId = parseInt(req.query?.shipment_id, 10);
      if (!shipmentId) return fail(res, 400, "shipment_id required");
      const r = await pool.query(
        "SELECT * FROM customs_shipment_containers WHERE shipment_id = $1 ORDER BY id ASC",
        [shipmentId]
      );
      return res.status(200).json({ success: true, data: r.rows, count: r.rowCount });
    } catch (err) {
      return fail(res, 500, err.message);
    }
  }

  if (req.method === "POST") {
    if (!canWrite(req.user)) return fail(res, 403, "Forbidden: admin/logistics only");
    try {
      const b = req.body || {};
      const shipmentId = parseInt(b.shipment_id, 10);
      if (!shipmentId || !b.container_no) return fail(res, 400, "shipment_id and container_no required");
      if (!(await shipmentExists(pool, shipmentId))) return fail(res, 400, "shipment_id not found");
      const r = await pool.query(
        `INSERT INTO customs_shipment_containers
         (shipment_id,container_no,seal_no,container_type,truck_no,driver_name,driver_tel,
          load_location,pickup_location,port_location,white_card_no,tare_kg)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (shipment_id, container_no) DO UPDATE
         SET container_no = EXCLUDED.container_no
         RETURNING *`,
        [
          shipmentId, b.container_no, b.seal_no || null, b.container_type || null,
          b.truck_no || null, b.driver_name || null, b.driver_tel || null,
          b.load_location || null, b.pickup_location || null, b.port_location || null,
          b.white_card_no || null, b.tare_kg ?? null,
        ]
      );
      return res.status(200).json({ success: true, data: r.rows[0] });
    } catch (err) {
      return fail(res, 500, err.message);
    }
  }

  if (req.method === "PATCH") {
    if (!canWrite(req.user)) return fail(res, 403, "Forbidden: admin/logistics only");
    try {
      const { id, ...patch } = req.body || {};
      if (!id) return fail(res, 400, "id required");
      const sets = [], vals = [];
      for (const k of ALLOWED_PATCH) {
        if (patch[k] !== undefined) {
          vals.push(patch[k] === "" ? null : patch[k]);
          sets.push(`${k} = $${vals.length}`);
        }
      }
      if (!sets.length) return fail(res, 400, "no fields to update");
      vals.push(id);
      const r = await pool.query(
        `UPDATE customs_shipment_containers SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`,
        vals
      );
      if (!r.rowCount) return fail(res, 404, "container not found");
      return res.status(200).json({ success: true, data: r.rows[0] });
    } catch (err) {
      if (err.code === "23505") return fail(res, 409, "container_no already exists in shipment");
      return fail(res, 500, err.message);
    }
  }

  return fail(res, 405, "Method not allowed");
}
