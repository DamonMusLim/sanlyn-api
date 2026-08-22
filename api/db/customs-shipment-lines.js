// /api/db/customs-shipment-lines.js
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const WRITE_ROLES = new Set(["admin", "logistics"]);
const READ_ROLES = new Set(["admin", "logistics", "sales", "ops", "finance"]);

function fail(res, status, error) {
  return res.status(status).json({ success: false, error });
}

function canRead(user) {
  return READ_ROLES.has(user?.role) || WRITE_ROLES.has(user?.role);
}

function canWrite(user) {
  return WRITE_ROLES.has(user?.role);
}

function isAdmin(user) {
  return user?.role === "admin";
}

function hasText(v) {
  return v !== undefined && v !== null && String(v).trim() !== "";
}

async function validateShipmentAndContainer(client, line) {
  const shipmentId = parseInt(line.shipment_id, 10);
  if (!shipmentId) throw Object.assign(new Error("shipment_id required"), { status: 400 });
  const sr = await client.query("SELECT 1 FROM customs_shipments WHERE id = $1 LIMIT 1", [shipmentId]);
  if (!sr.rowCount) throw Object.assign(new Error("shipment_id not found"), { status: 400 });
  if (line.container_id !== undefined && line.container_id !== null && line.container_id !== "") {
    const containerId = parseInt(line.container_id, 10);
    const cr = await client.query(
      "SELECT 1 FROM customs_shipment_containers WHERE id = $1 AND shipment_id = $2 LIMIT 1",
      [containerId, shipmentId]
    );
    if (!cr.rowCount) throw Object.assign(new Error("container_id not found in shipment"), { status: 400 });
  }
}

async function validateRedLine(client, line) {
  const name = String(line.declaration_name || "").trim();
  const shipmentId = parseInt(line.shipment_id, 10);
  const isDanger = line.is_dangerous_goods === true || hasText(line.un_no);
  const isMeat = line.contains_meat === true;
  if (!name) throw Object.assign(new Error("declaration_name required"), { status: 400 });
  if (Number(line.ctns) <= 0) throw Object.assign(new Error("ctns must be greater than 0"), { status: 400 });
  if (isDanger && isMeat) {
    throw Object.assign(new Error("dangerous goods and meat lines cannot share declaration_name"), { status: 400 });
  }
  const checks = [];
  if (isDanger) checks.push("contains_meat = true");
  if (isMeat) checks.push("(is_dangerous_goods = true OR COALESCE(un_no, '') <> '')");
  if (!checks.length) return;
  const r = await client.query(
    `SELECT id FROM customs_shipment_lines
     WHERE shipment_id = $1 AND declaration_name = $2 AND (${checks.join(" OR ")})
     LIMIT 1`,
    [shipmentId, name]
  );
  if (r.rowCount) {
    throw Object.assign(new Error("dangerous goods and meat lines cannot share declaration_name"), { status: 400 });
  }
}

async function insertLine(client, line, sortOrder) {
  await validateShipmentAndContainer(client, line);
  await validateRedLine(client, line);
  const r = await client.query(
    `INSERT INTO customs_shipment_lines
     (shipment_id,container_id,declaration_name,hs_code,declaration_elements,ctns,nw_kg,gw_kg,cbm,
      amount,currency,requires_quarantine_cert,contains_meat,is_dangerous_goods,un_no,sort_order)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [
      parseInt(line.shipment_id, 10), line.container_id ? parseInt(line.container_id, 10) : null,
      String(line.declaration_name).trim(), line.hs_code || null, line.declaration_elements || null,
      line.ctns, line.nw_kg ?? null, line.gw_kg ?? null, line.cbm ?? null, line.amount ?? null,
      line.currency || "CNY", line.requires_quarantine_cert === true, line.contains_meat === true,
      line.is_dangerous_goods === true, line.un_no || null, line.sort_order ?? sortOrder,
    ]
  );
  return r.rows[0];
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const pool = getPool();

  if (req.method === "GET") {
    if (!canRead(req.user)) return fail(res, 403, "Forbidden");
    try {
      const conds = [], params = [];
      if (req.query?.shipment_id) {
        params.push(parseInt(req.query.shipment_id, 10));
        conds.push(`shipment_id = $${params.length}`);
      }
      if (req.query?.container_id) {
        params.push(parseInt(req.query.container_id, 10));
        conds.push(`container_id = $${params.length}`);
      }
      if (!conds.length) return fail(res, 400, "shipment_id or container_id required");
      const r = await pool.query(
        `SELECT * FROM customs_shipment_lines WHERE ${conds.join(" AND ")} ORDER BY sort_order ASC, id ASC`,
        params
      );
      return res.status(200).json({ success: true, data: r.rows, count: r.rowCount });
    } catch (err) {
      return fail(res, 500, err.message);
    }
  }

  if (req.method === "POST") {
    if (!canWrite(req.user)) return fail(res, 403, "Forbidden: admin/logistics only");
    const client = await pool.connect();
    try {
      const body = req.body || {};
      const lines = Array.isArray(body.lines)
        ? body.lines.map(line => ({
            shipment_id: body.shipment_id,
            container_id: body.container_id,
            ...line,
          }))
        : [body];
      if (!lines.length) return fail(res, 400, "lines required");
      await client.query("BEGIN");
      const rows = [];
      for (let i = 0; i < lines.length; i += 1) {
        rows.push(await insertLine(client, lines[i], i));
      }
      await client.query("COMMIT");
      return res.status(201).json({ success: true, data: rows, count: rows.length });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      return fail(res, err.status || 500, err.message);
    } finally {
      client.release();
    }
  }

  if (req.method === "DELETE") {
    if (!isAdmin(req.user)) return fail(res, 403, "Forbidden: admin only");
    try {
      const id = req.body?.id;
      if (!id) return fail(res, 400, "id required");
      const r = await pool.query("DELETE FROM customs_shipment_lines WHERE id = $1 RETURNING *", [id]);
      if (!r.rowCount) return fail(res, 404, "line not found");
      return res.status(200).json({ success: true, data: r.rows[0] });
    } catch (err) {
      return fail(res, 500, err.message);
    }
  }

  return fail(res, 405, "Method not allowed");
}
