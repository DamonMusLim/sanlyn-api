// /api/db/customs-shipments.js
// Independent customs-service shipment headers for customer-owned goods.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const WRITE_ROLES = new Set(["admin", "logistics"]);
const READ_ROLES = new Set(["admin", "logistics", "sales", "ops", "finance"]);
const ALLOWED_PATCH = [
  "shipment_no", "company_code", "contract_no", "bl_no", "vessel", "voyage",
  "pol", "pod", "forwarder", "etd", "status", "notes", "created_by",
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

async function companyExists(pool, code) {
  const r = await pool.query("SELECT 1 FROM companies WHERE code = $1 LIMIT 1", [code]);
  return r.rowCount > 0;
}

function addFilter(conds, params, field, value) {
  if (value !== undefined && value !== null && String(value).trim() !== "") {
    params.push(String(value).trim());
    conds.push(`${field} = $${params.length}`);
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const pool = getPool();

  if (req.method === "GET") {
    if (!canRead(req.user)) return fail(res, 403, "Forbidden");
    try {
      const { shipment_no, company_code, bl_no, id, limit = 100 } = req.query || {};
      const conds = [], params = [];
      addFilter(conds, params, "shipment_no", shipment_no);
      addFilter(conds, params, "company_code", company_code);
      addFilter(conds, params, "bl_no", bl_no);
      if (id) {
        params.push(parseInt(id, 10));
        conds.push(`id = $${params.length}`);
      }
      let sql = "SELECT * FROM customs_shipments";
      if (conds.length) sql += " WHERE " + conds.join(" AND ");
      params.push(Math.min(parseInt(limit, 10) || 100, 500));
      sql += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;
      const r = await pool.query(sql, params);
      return res.status(200).json({ success: true, data: r.rows, count: r.rowCount });
    } catch (err) {
      return fail(res, 500, err.message);
    }
  }

  if (req.method === "POST") {
    if (!canWrite(req.user)) return fail(res, 403, "Forbidden: admin/logistics only");
    try {
      const b = req.body || {};
      if (!b.shipment_no || !b.company_code) return fail(res, 400, "shipment_no and company_code required");
      if (!(await companyExists(pool, b.company_code))) return fail(res, 400, "company_code not found");
      const r = await pool.query(
        `INSERT INTO customs_shipments
         (shipment_no,company_code,contract_no,bl_no,vessel,voyage,pol,pod,forwarder,etd,notes,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [
          b.shipment_no, b.company_code, b.contract_no || null, b.bl_no || null,
          b.vessel || null, b.voyage || null, b.pol || null, b.pod || null,
          b.forwarder || null, b.etd || null, b.notes || null,
          b.created_by || req.user?.email || req.user?.username || null,
        ]
      );
      return res.status(201).json({ success: true, data: r.rows[0] });
    } catch (err) {
      if (err.code === "23505") return fail(res, 409, "shipment_no already exists");
      return fail(res, 500, err.message);
    }
  }

  if (req.method === "PATCH") {
    if (!canWrite(req.user)) return fail(res, 403, "Forbidden: admin/logistics only");
    try {
      const { id, ...patch } = req.body || {};
      if (!id) return fail(res, 400, "id required");
      if (patch.company_code && !(await companyExists(pool, patch.company_code))) {
        return fail(res, 400, "company_code not found");
      }
      const sets = [], vals = [];
      for (const k of ALLOWED_PATCH) {
        if (patch[k] !== undefined) {
          vals.push(patch[k] === "" ? null : patch[k]);
          sets.push(`${k} = $${vals.length}`);
        }
      }
      if (!sets.length) return fail(res, 400, "no fields to update");
      vals.push(id);
      sets.push("updated_at = NOW()");
      const r = await pool.query(`UPDATE customs_shipments SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`, vals);
      if (!r.rowCount) return fail(res, 404, "shipment not found");
      return res.status(200).json({ success: true, data: r.rows[0] });
    } catch (err) {
      if (err.code === "23505") return fail(res, 409, "shipment_no already exists");
      return fail(res, 500, err.message);
    }
  }

  return fail(res, 405, "Method not allowed");
}
