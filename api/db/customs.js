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

    // ── Part 1: customs_data LEFT JOIN shipping_plans（已建档的票，补 SO/BL/船期）──
    const conds = [];
    const vals = [];

    if (!isPrivileged) {
      conds.push(`cd.tenant_id = $${vals.length + 1}`);
      vals.push(userCompanyCode);
    }
    if (contract) {
      conds.push(`cd.contract_no = $${vals.length + 1}`);
      vals.push(contract);
    }
    if (shipment) {
      conds.push(`(cd.shipment_no = $${vals.length + 1} OR sp.shipment_no = $${vals.length + 1})`);
      vals.push(shipment);
    }

    const where1 = conds.length ? "WHERE " + conds.join(" AND ") : "";
    const q1 = await pool.query(`
      SELECT cd.*,
        COALESCE(NULLIF(sp.bl_no,''), NULLIF(sp.so_no,''), sp.mbl_no) AS sp_effective_bl,
        sp.so_no   AS sp_so_no,
        sp.bl_no   AS sp_bl_no,
        sp.vessel  AS sp_vessel,
        sp.voyage  AS sp_voyage,
        sp.etd     AS sp_etd,
        sp.pol     AS sp_pol,
        sp.pod     AS sp_pod
      FROM customs_data cd
      LEFT JOIN shipping_plans sp ON sp.id = cd.shipping_plan_id
      ${where1}
      ORDER BY cd.updated_at DESC
    `, vals);

    // ── Part 2: shipping_plans 有 BL/SO 但还没建 customs_data 的票（虚拟行）──
    // 只在全量列表时补（加了 contract/shipment 精确过滤时不补，避免噪音）
    let virtualRows = [];
    if (!contract && !shipment) {
      const q2 = await pool.query(`
        SELECT
          ('sp_' || sp.id)                                          AS _id,
          NULL::text                                                 AS customs_no,
          sp.shipment_no,
          NULL::text                                                 AS contract_no,
          NULL::text                                                 AS order_no,
          NULL::jsonb                                                AS customs_dec_official,
          NULL::jsonb                                                AS release_note,
          NULL::jsonb                                                AS booking_note,
          NULL::jsonb                                                AS bl_draft,
          NULL::jsonb                                                AS bl_final,
          NULL::jsonb                                                AS customs_dec,
          NULL::jsonb                                                AS origin_cert,
          NULL::jsonb                                                AS quarantine_report,
          NULL::jsonb                                                AS seal_photos,
          NULL::jsonb                                                AS factory_sign,
          NULL::jsonb                                                AS loading_details,
          NULL::jsonb                                                AS raw,
          sp.updated_at,
          NULL::text                                                 AS insured,
          NULL::numeric                                              AS insurance_rate,
          NULL::text                                                 AS insurance_policy_no,
          NULL::numeric                                              AS insurance_premium,
          sp.id                                                      AS shipping_plan_id,
          COALESCE(NULLIF(sp.bl_no,''), NULLIF(sp.so_no,''), sp.mbl_no) AS sp_effective_bl,
          sp.so_no   AS sp_so_no,
          sp.bl_no   AS sp_bl_no,
          sp.vessel  AS sp_vessel,
          sp.voyage  AS sp_voyage,
          sp.etd     AS sp_etd,
          sp.pol     AS sp_pol,
          sp.pod     AS sp_pod
        FROM shipping_plans sp
        WHERE (NULLIF(sp.bl_no,'') IS NOT NULL OR NULLIF(sp.so_no,'') IS NOT NULL)
          AND NOT EXISTS (
            SELECT 1 FROM customs_data cd2 WHERE cd2.shipping_plan_id = sp.id
          )
        ORDER BY sp.etd DESC NULLS LAST
      `);
      virtualRows = q2.rows;
    }

    return res.status(200).json({ data: [...q1.rows, ...virtualRows] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
