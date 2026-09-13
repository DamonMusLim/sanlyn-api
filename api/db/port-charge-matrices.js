import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const MATRIX_TABLE = "port_charge_matrices";
const ITEM_TABLE = "port_charge_matrix_items";

const MATRIX_FIELDS = [
  "code", "forwarder_company_id", "carrier_code", "pol", "pod", "bl_type",
  "free_days_origin", "free_days_dest", "total_cost_20gp", "total_cost_40hq",
  "cost_currency", "is_active", "valid_from", "valid_to",
];
const ITEM_FIELDS = [
  "matrix_code", "charge_name", "currency", "unit", "container_type",
  "unit_price", "qty", "amount", "is_required", "sort_order",
];
const MATRIX_REQUIRED = [
  "code", "carrier_code", "pol", "pod", "total_cost_20gp",
  "total_cost_40hq", "cost_currency",
];
const ITEM_REQUIRED = ["matrix_code", "charge_name", "unit_price", "amount", "currency"];
const NUMDATE_COLS = new Set([
  "total_cost_20gp", "total_cost_40hq", "free_days_origin", "free_days_dest",
  "unit_price", "qty", "amount", "sort_order", "valid_from", "valid_to",
]);

const blankToNull = (k, v) => (NUMDATE_COLS.has(k) && v === "" ? null : v);
const hasValue = v => v !== null && v !== undefined && String(v).trim() !== "";

function missingRequired(body, required) {
  return required.filter(k => !hasValue(body[k]));
}

function editablePayload(body, fields, blocked = []) {
  const blockedSet = new Set(blocked);
  const cols = [];
  const vals = [];
  const params = [];
  for (const k of fields) {
    if (blockedSet.has(k)) continue;
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      cols.push(k);
      params.push(blankToNull(k, body[k]));
      vals.push(`$${params.length}`);
    }
  }
  return { cols, vals, params };
}

async function insertRow(pool, table, fields, body) {
  const { cols, vals, params } = editablePayload(body, fields);
  if (!cols.length) return { status: 400, json: { success: false, error: "no fields" } };
  const r = await pool.query(
    `INSERT INTO ${table} (${cols.join(",")}) VALUES (${vals.join(",")}) RETURNING *`,
    params
  );
  return { status: 201, json: { success: true, data: r.rows[0] } };
}

async function updateRow(pool, table, fields, body, key, keyValue) {
  const { params } = editablePayload(body, fields, [key]);
  const sets = [];
  let idx = 0;
  for (const k of fields) {
    if (k === key) continue;
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      idx += 1;
      sets.push(`${k} = $${idx}`);
    }
  }
  if (!sets.length) return { status: 400, json: { success: false, error: "no editable fields" } };
  params.push(keyValue);
  const r = await pool.query(
    `UPDATE ${table} SET ${sets.join(", ")} WHERE ${key} = $${params.length} RETURNING *`,
    params
  );
  if (!r.rows.length) return { status: 404, json: { success: false, error: "not found" } };
  return { status: 200, json: { success: true, data: r.rows[0] } };
}

async function setDeletedAt(pool, table, key, keyValue, deleted) {
  const r = await pool.query(
    `UPDATE ${table} SET deleted_at = ${deleted ? "now()" : "NULL"} WHERE ${key} = $1 RETURNING *`,
    [keyValue]
  );
  if (!r.rows.length) return { status: 404, json: { success: false, error: "not found" } };
  return { status: 200, json: { success: true, data: r.rows[0] } };
}

async function handlePost(pool, body) {
  if (!body.kind) return { status: 400, json: { success: false, error: "kind required" } };
  if (body.kind === "matrix") {
    const missing = missingRequired(body, MATRIX_REQUIRED);
    if (missing.length) return { status: 400, json: { success: false, error: `missing required: ${missing.join(", ")}` } };
    return insertRow(pool, MATRIX_TABLE, MATRIX_FIELDS, body);
  }
  if (body.kind === "item") {
    const missing = missingRequired(body, ITEM_REQUIRED);
    if (missing.length) return { status: 400, json: { success: false, error: `missing required: ${missing.join(", ")}` } };
    return insertRow(pool, ITEM_TABLE, ITEM_FIELDS, body);
  }
  return { status: 400, json: { success: false, error: "bad kind" } };
}

async function handlePatch(pool, body) {
  if (!body.kind) return { status: 400, json: { success: false, error: "kind required" } };
  if (body.kind === "matrix") {
    if (!hasValue(body.code)) return { status: 400, json: { success: false, error: "code required" } };
    if (Object.prototype.hasOwnProperty.call(body, "deleted")) return setDeletedAt(pool, MATRIX_TABLE, "code", body.code, body.deleted === true);
    return updateRow(pool, MATRIX_TABLE, MATRIX_FIELDS, body, "code", body.code);
  }
  if (body.kind === "item") {
    const id = parseInt(body.id, 10);
    if (!Number.isFinite(id)) return { status: 400, json: { success: false, error: "id required" } };
    if (Object.prototype.hasOwnProperty.call(body, "deleted")) return setDeletedAt(pool, ITEM_TABLE, "id", id, body.deleted === true);
    return updateRow(pool, ITEM_TABLE, ITEM_FIELDS, body, "id", id);
  }
  return { status: 400, json: { success: false, error: "bad kind" } };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method === "GET") {
    return res.status(405).json({ success: false, error: "列表读 /api/db/rates-hub" });
  }
  if (req.method !== "POST" && req.method !== "PATCH") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }
  if (!requireAuth(req, res)) return;

  try {
    const pool = getPool();
    const body = req.body || {};
    const result = req.method === "POST"
      ? await handlePost(pool, body)
      : await handlePatch(pool, body);
    return res.status(result.status).json(result.json);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
