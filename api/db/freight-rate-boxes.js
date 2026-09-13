import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const TABLE = "freight_rate_boxes";
const LEGACY_MAIN_COL_TYPES = new Set(["20GP", "40HQ", "20RF", "40RH"]);
const INSERT_FIELDS = ["rate_id", "container_type", "cost", "customer_price", "remarks"];
const PATCH_FIELDS = ["cost", "customer_price", "remarks"];
const NUM_COLS = new Set(["cost", "customer_price"]);

const blankToNull = (k, v) => (NUM_COLS.has(k) && v === "" ? null : v);
const hasValue = v => v !== null && v !== undefined && String(v).trim() !== "";

function normalizeContainerType(v) {
  return String(v || "").trim().toUpperCase();
}

function editablePayload(body, fields) {
  const cols = [];
  const vals = [];
  const params = [];
  for (const k of fields) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      cols.push(k);
      params.push(blankToNull(k, body[k]));
      vals.push(`$${params.length}`);
    }
  }
  return { cols, vals, params };
}

async function ensureContainerType(pool, code) {
  const r = await pool.query("SELECT code FROM container_types WHERE code = $1 LIMIT 1", [code]);
  return Boolean(r.rows.length);
}

async function handlePost(pool, body) {
  const rateId = Number(body.rate_id);
  const containerType = normalizeContainerType(body.container_type);
  if (!Number.isInteger(rateId) || rateId <= 0 || !hasValue(containerType)) {
    return { status: 400, json: { success: false, error: "rate_id 和 container_type 必填" } };
  }
  if (LEGACY_MAIN_COL_TYPES.has(containerType)) {
    return { status: 400, json: { success: false, error: "20GP/40HQ/20RF/40RH 这四种走运价主表的列，不进子表" } };
  }
  if (!(await ensureContainerType(pool, containerType))) {
    return { status: 400, json: { success: false, error: `container_type 不存在: ${containerType}` } };
  }
  const normalizedBody = { ...body, rate_id: rateId, container_type: containerType };
  const { cols, vals, params } = editablePayload(normalizedBody, INSERT_FIELDS);
  const r = await pool.query(
    `INSERT INTO ${TABLE} (${cols.join(",")}) VALUES (${vals.join(",")}) RETURNING *`,
    params
  );
  return { status: 201, json: { success: true, data: r.rows[0] } };
}

async function handlePatch(pool, body) {
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return { status: 400, json: { success: false, error: "id required" } };
  const { params } = editablePayload(body, PATCH_FIELDS);
  const sets = [];
  let idx = 0;
  for (const k of PATCH_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      idx += 1;
      sets.push(`${k} = $${idx}`);
    }
  }
  if (!sets.length) return { status: 400, json: { success: false, error: "no editable fields" } };
  sets.push("updated_at = now()");
  params.push(id);
  const r = await pool.query(
    `UPDATE ${TABLE} SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!r.rows.length) return { status: 404, json: { success: false, error: "not found" } };
  return { status: 200, json: { success: true, data: r.rows[0] } };
}

async function handleDelete(pool, body) {
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return { status: 400, json: { success: false, error: "id required" } };
  const r = await pool.query(`DELETE FROM ${TABLE} WHERE id = $1 RETURNING *`, [id]);
  if (!r.rows.length) return { status: 404, json: { success: false, error: "not found" } };
  return { status: 200, json: { success: true, data: r.rows[0] } };
}

function mapDbError(err) {
  if (err?.code === "23505") {
    return { status: 409, json: { success: false, error: "该运价已有这个箱型，请改不要新增" } };
  }
  if (err?.code === "23503") {
    return { status: 400, json: { success: false, error: err.constraint || "关联记录不存在" } };
  }
  return null;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method === "GET") {
    return res.status(405).json({ success: false, error: "列表读 /api/db/rates-hub" });
  }
  if (!["POST", "PATCH", "DELETE"].includes(req.method)) {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }
  if (!requireAuth(req, res)) return;

  try {
    const pool = getPool();
    const body = req.body || {};
    const result = req.method === "POST"
      ? await handlePost(pool, body)
      : req.method === "PATCH"
        ? await handlePatch(pool, body)
        : await handleDelete(pool, body);
    return res.status(result.status).json(result.json);
  } catch (err) {
    const mapped = mapDbError(err);
    if (mapped) return res.status(mapped.status).json(mapped.json);
    return res.status(500).json({ success: false, error: err.message });
  }
}
