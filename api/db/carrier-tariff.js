import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

function intVal(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

async function tableColumns(pool, table) {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  return new Set(r.rows.map(row => row.column_name));
}

function pick(cols, names) {
  return names.filter(name => cols.has(name)).map(name => `"${name}"`).join(", ");
}

async function listVersions(pool, req, res) {
  const limit = intVal(req.query.limit, 100);
  const port = req.query.port;
  const params = [];
  let where = "";
  if (port) { params.push(port); where = "WHERE port ILIKE $1"; }
  params.push(limit);
  const r = await pool.query(
    `SELECT id, version, source_doc, port, import_status, effective_from, created_at,
            (import_status='active') AS active
       FROM carrier_tariff_versions
       ${where}
      ORDER BY (import_status='active') DESC, effective_from DESC NULLS LAST, id DESC
      LIMIT $${params.length}`,
    params
  );
  return res.status(200).json({ success: true, data: r.rows });
}

async function listStandards(pool, req, res) {
  const limit = intVal(req.query.limit, 1000);
  const versionId = intVal(req.query.version_id, null);
  const params = [];
  const conds = [];
  if (versionId) { params.push(versionId); conds.push(`s.version_id=$${params.length}`); }
  if (req.query.review_status) { params.push(req.query.review_status); conds.push(`s.review_status=$${params.length}`); }
  if (req.query.carrier) { params.push(`%${req.query.carrier}%`); conds.push(`s.carrier ILIKE $${params.length}`); }
  const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
  params.push(limit);
  const r = await pool.query(
    `SELECT s.*, v.version, v.port, v.import_status
       FROM carrier_tariff_standards s
       JOIN carrier_tariff_versions v ON v.id = s.version_id
       ${where}
      ORDER BY s.review_status DESC, s.carrier, s.container_type, s.charge_item_code, s.id
      LIMIT $${params.length}`,
    params
  );
  return res.status(200).json({ success: true, data: r.rows });
}

async function listUnmapped(pool, req, res) {
  const limit = intVal(req.query.limit, 300);
  const cols = await tableColumns(pool, "carrier_tariff_charge_items");
  const selected = pick(cols, ["id", "raw_item_name", "standard_item_code", "standard_item_name", "notes", "created_at", "updated_at"]) || "*";
  const r = await pool.query(
    `SELECT ${selected}
       FROM carrier_tariff_charge_items
      WHERE COALESCE(standard_item_code, '') = ''
      ORDER BY raw_item_name
      LIMIT $1`,
    [limit]
  );
  return res.status(200).json({ success: true, data: r.rows });
}

async function setActive(pool, req, res) {
  const id = intVal(req.body?.id, null);
  if (!id) return res.status(400).json({ success: false, error: "id required" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await client.query("SELECT id, port FROM carrier_tariff_versions WHERE id=$1 FOR UPDATE", [id]);
    if (!row.rows.length) throw new Error("version not found");
    await client.query(
      `UPDATE carrier_tariff_versions
          SET import_status='inactive'
        WHERE port = $1 AND import_status='active' AND id <> $2`,
      [row.rows[0].port, id]
    );
    const updated = await client.query(
      "UPDATE carrier_tariff_versions SET import_status='active' WHERE id=$1 RETURNING *",
      [id]
    );
    await client.query("COMMIT");
    return res.status(200).json({ success: true, data: updated.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
}

async function confirmStandards(pool, req, res) {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(v => intVal(v, null)).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ success: false, error: "ids required" });
  const r = await pool.query(
    `UPDATE carrier_tariff_standards
        SET review_status='confirmed'
      WHERE id = ANY($1::int[]) AND review_status='pending'
      RETURNING id, review_status`,
    [ids]
  );
  return res.status(200).json({ success: true, data: r.rows, count: r.rowCount });
}

async function updateMapping(pool, req, res) {
  const body = req.body || {};
  const id = intVal(body.id, null);
  const raw = String(body.raw_item_name || "").trim();
  const code = String(body.standard_item_code || "").trim();
  if (!code || (!id && !raw)) return res.status(400).json({ success: false, error: "id/raw_item_name and standard_item_code required" });
  const cols = await tableColumns(pool, "carrier_tariff_charge_items");
  const sets = ["standard_item_code=$1"];
  const params = [code];
  if (cols.has("standard_item_name") && body.standard_item_name !== undefined) {
    params.push(body.standard_item_name || null);
    sets.push(`standard_item_name=$${params.length}`);
  }
  if (cols.has("updated_at")) sets.push("updated_at=now()");
  if (id) {
    params.push(id);
    const r = await pool.query(`UPDATE carrier_tariff_charge_items SET ${sets.join(", ")} WHERE id=$${params.length} RETURNING *`, params);
    return res.status(200).json({ success: true, data: r.rows[0] || null });
  }
  params.push(raw);
  const r = await pool.query(`UPDATE carrier_tariff_charge_items SET ${sets.join(", ")} WHERE raw_item_name=$${params.length} RETURNING *`, params);
  return res.status(200).json({ success: true, data: r.rows[0] || null });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  try {
    if (req.method === "GET") {
      if (req.query.action === "standards") return listStandards(pool, req, res);
      if (req.query.action === "unmapped") return listUnmapped(pool, req, res);
      return listVersions(pool, req, res);
    }
    if (req.method === "POST") {
      if (req.body?.action === "set_active") return setActive(pool, req, res);
      if (req.body?.action === "confirm_standards") return confirmStandards(pool, req, res);
    }
    if (req.method === "PATCH") return updateMapping(pool, req, res);
    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
