// sanlyn-api/api/db/customs.js
// GET /api/db/customs              → 全部
// GET /api/db/customs?contract=xxx → 按合同号过滤
// GET /api/db/customs?shipment=xxx → 按出运编号过滤
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js"; // S18.1: handler-level auth guard

// customs_data 可写列（key=_id 不在内）。object/array 值自动 ::jsonb。
const CUSTOMS_WRITABLE = ["customs_no","shipment_no","contract_no","order_no",
  "customs_dec_official","release_note","booking_note","bl_draft","bl_final","customs_dec",
  "origin_cert","quarantine_report","seal_photos","factory_sign","loading_details","raw",
  "insured","insurance_rate","insurance_policy_no","insurance_premium"];
const CUSTOMS_JSONB = new Set(["customs_dec_official","release_note","booking_note","bl_draft","bl_final",
  "customs_dec","origin_cert","quarantine_report","seal_photos","factory_sign","loading_details","raw"]);
function buildSet(body, writable, params, jsonbCols) {
  const sets = [];
  for (const col of writable) {
    if (!Object.prototype.hasOwnProperty.call(body, col)) continue;
    const v = body[col];
    if (jsonbCols && jsonbCols.has(col)) { params.push(v == null ? null : JSON.stringify(v)); sets.push(`${col} = $${params.length}::jsonb`); }
    else { params.push(v); sets.push(`${col} = $${params.length}`); }
  }
  return sets;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return; // S18.1: 401 if no valid JWT
  const poolW = getPool();

  // ── POST: 新建报关资料（修复「写不进」：原来 GET only）──
  if (req.method === "POST") {
    try {
      const body = req.body || {};
      const params = [];
      const sets = buildSet(body, CUSTOMS_WRITABLE, params, CUSTOMS_JSONB);
      const _id = (body._id && String(body._id)) || ("cd_" + Math.random().toString(36).slice(2) + Date.now().toString(36));
      params.push(_id); sets.push(`_id = $${params.length}`);
      sets.push(`updated_at = now()`);
      if (sets.length <= 2) return res.status(400).json({ success:false, error:"no fields" });
      const cols = sets.map(s => s.split(" = ")[0]);
      const vals = sets.map(s => s.split(" = ")[1]);
      const r = await poolW.query(`INSERT INTO customs_data (${cols.join(",")}) VALUES (${vals.join(",")}) RETURNING *`, params);
      return res.status(201).json({ success:true, data:r.rows[0] });
    } catch (err) { return res.status(500).json({ success:false, error: err.message }); }
  }

  // ── PATCH: 更新报关资料（by _id / contract_no）──
  if (req.method === "PATCH") {
    try {
      const body = req.body || {};
      const _id = body._id != null ? String(body._id) : null;
      const cn = (!_id && body.contract_no) ? String(body.contract_no) : null;
      if (!_id && !cn) return res.status(400).json({ success:false, error:"_id or contract_no required" });
      const params = [];
      const sets = buildSet(body, CUSTOMS_WRITABLE, params, CUSTOMS_JSONB);
      if (!sets.length) return res.status(400).json({ success:false, error:"no editable fields" });
      sets.push(`updated_at = now()`);
      let where;
      if (_id) { params.push(_id); where = `_id = $${params.length}`; }
      else { params.push(cn); where = `contract_no = $${params.length}`; }
      const r = await poolW.query(`UPDATE customs_data SET ${sets.join(", ")} WHERE ${where} RETURNING *`, params);
      if (!r.rows.length) return res.status(404).json({ success:false, error:"not found" });
      return res.status(200).json({ success:true, data:r.rows[0] });
    } catch (err) { return res.status(500).json({ success:false, error: err.message }); }
  }

  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  try {
    const pool = getPool();
    const { contract, shipment } = req.query;

    const userCompanyCode = req.user.companyCode || req.user.company_code;
    const isPrivileged = req.user.role === 'admin' || req.user.role === 'system';
    if (!userCompanyCode && !isPrivileged) {
      return res.status(403).json({ error: 'Forbidden', message: '无法确定您的公司归属' });
    }

    let sql = "SELECT * FROM customs_data";
    const vals = [];
    const conds = [];

    if (!isPrivileged) {
      conds.push(`tenant_id = $${vals.length + 1}`);
      vals.push(userCompanyCode);
    }

    if (contract) {
      conds.push(`contract_no = $${vals.length + 1}`);
      vals.push(contract);
    }
    if (shipment) {
      conds.push(`shipment_no = $${vals.length + 1}`);
      vals.push(shipment);
    }
    if (conds.length) sql += " WHERE " + conds.join(" AND ");
    sql += " ORDER BY updated_at DESC";

    const result = await pool.query(sql, vals);
    return res.status(200).json({ data: result.rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
