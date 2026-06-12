// /api/db/trucking-vendors.js — 拖车商+线路 双表 CRUD
// trucking_vendors(_id, vendor_cn, province, surge, currency, notes, raw)
// trucking_routes(_id, vendor_id FK, factory_name, pickup_city, pol, pol_terminal, distance_km,
//                 valid_from, valid_to, rates jsonb, notes)
import { getPool, setCors } from "./db.js";
import { requireAuth } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();

  // ── GET: ?list=factories → 返回工厂公司列表（供前端选择器用）──
  if (req.method === "GET" && req.query.list === "factories") {
    try {
      const r = await pool.query(
        `SELECT id, code, name_cn, type, province FROM companies
         WHERE type IN ('factory','trucking') AND active = true
         ORDER BY type, name_cn`
      );
      return res.json({ success: true, data: r.rows });
    } catch(e) { return res.status(500).json({ success: false, error: e.message }); }
  }

  // ── GET: vendors with embedded routes ──
  if (req.method === "GET") {
    try {
      const { province, id } = req.query;
      let vendorQ = "SELECT * FROM trucking_vendors";
      const vParams = [];
      if (id)       { vParams.push(id);       vendorQ += ` WHERE _id = $1`; }
      else if (province) { vParams.push(`%${province}%`); vendorQ += ` WHERE province ILIKE $1`; }
      vendorQ += " ORDER BY province ASC, vendor_cn ASC";

      const vendors = (await pool.query(vendorQ, vParams)).rows;
      if (!vendors.length) return res.json({ success: true, data: [] });

      const vendorIds = vendors.map(v => v._id);
      const routes = (await pool.query(
        `SELECT r.*, c.name_cn AS factory_company_name, c.code AS factory_company_code
         FROM trucking_routes r
         LEFT JOIN companies c ON c.id = r.factory_company_id
         WHERE r.vendor_id = ANY($1::uuid[])
         ORDER BY r.vendor_id, r.factory_name ASC`,
        [vendorIds]
      )).rows;

      const routeMap = {};
      for (const r of routes) {
        if (!routeMap[r.vendor_id]) routeMap[r.vendor_id] = [];
        routeMap[r.vendor_id].push(r);
      }

      const data = vendors.map(v => ({ ...v, routes: routeMap[v._id] || [] }));
      return res.json({ success: true, data, count: data.length });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  }

  // ── POST: create vendor OR route ──
  if (req.method === "POST") {
    if (!requireAuth(req, res)) return;
    const { _type, ...body } = req.body || {};

    // POST route (child)
    if (_type === "route") {
      try {
        const { vendor_id, factory_company_id, factory_name, pickup_city, pol, pol_terminal,
                distance_km, valid_from, valid_to, rates, notes, tax_included } = body;
        if (!vendor_id) return res.status(400).json({ error: "vendor_id required" });
        // 铁律：有费率必须有公司ID
        const hasRates = rates && Object.keys(rates).length > 0;
        if (hasRates && !factory_company_id) {
          return res.status(422).json({ error: "工厂未在公司表登记，不能录入价格。请先在「公司」模块新增该工厂。" });
        }
        // 验证公司存在
        if (factory_company_id) {
          const chk = await pool.query("SELECT id FROM companies WHERE id=$1 AND type='factory'", [factory_company_id]);
          if (!chk.rowCount) return res.status(422).json({ error: "工厂公司ID不存在或类型不是factory" });
        }
        const taxOk = tax_included === false ? false : true;
        const r = await pool.query(
          `INSERT INTO trucking_routes(vendor_id,factory_company_id,factory_name,pickup_city,
             pol,pol_terminal,distance_km,valid_from,valid_to,rates,notes,tax_included)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12) RETURNING *`,
          [vendor_id, factory_company_id||null, factory_name||null, pickup_city||null,
           pol||null, pol_terminal||null, distance_km||null,
           valid_from||null, valid_to||null, JSON.stringify(rates||{}), notes||null, taxOk]
        );
        return res.status(201).json({ success: true, data: r.rows[0] });
      } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
    }

    // POST vendor (parent)
    try {
      const { vendor_cn, province, surge, currency, notes, raw } = body;
      if (!vendor_cn) return res.status(400).json({ error: "vendor_cn required" });
      const r = await pool.query(
        `INSERT INTO trucking_vendors(vendor_cn,province,surge,currency,notes,raw)
         VALUES($1,$2,$3::jsonb,$4,$5,$6::jsonb) RETURNING *`,
        [vendor_cn, province||'其他', JSON.stringify(surge||{}),
         currency||'CNY', notes||null, raw ? JSON.stringify(raw) : null]
      );
      return res.status(201).json({ success: true, data: { ...r.rows[0], routes: [] } });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  }

  // ── PATCH: update vendor or route ──
  if (req.method === "PATCH") {
    if (!requireAuth(req, res)) return;
    const { _type, _id, ...patch } = req.body || {};
    if (!_id) return res.status(400).json({ error: "_id required" });

    if (_type === "route") {
      // 铁律：有费率必须有公司ID
      if (patch.rates && Object.keys(patch.rates).length > 0 && !patch.factory_company_id) {
        // 检查现有记录是否已有company_id
        const existing = await pool.query("SELECT factory_company_id FROM trucking_routes WHERE _id=$1", [_id]);
        if (!existing.rows[0]?.factory_company_id) {
          return res.status(422).json({ error: "工厂未在公司表登记，不能录入价格。请先在「公司」模块新增该工厂。" });
        }
      }
      const SCALAR = ["factory_name","pickup_city","pol","pol_terminal","distance_km",
                      "valid_from","valid_to","notes","factory_company_id","tax_included"];
      const JSONB  = ["rates"];
      const sets = [], vals = [];
      for (const k of SCALAR) {
        if (patch[k] !== undefined) { vals.push(patch[k]); sets.push(`${k}=$${vals.length}`); }
      }
      for (const k of JSONB) {
        if (patch[k] !== undefined) { vals.push(JSON.stringify(patch[k])); sets.push(`${k}=$${vals.length}::jsonb`); }
      }
      if (!sets.length) return res.status(400).json({ error: "nothing to update" });
      sets.push("updated_at=now()"); vals.push(_id);
      try {
        const r = await pool.query(
          `UPDATE trucking_routes SET ${sets.join(",")} WHERE _id=$${vals.length} RETURNING *`, vals
        );
        if (!r.rowCount) return res.status(404).json({ error: "route not found" });
        return res.json({ success: true, data: r.rows[0] });
      } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
    }

    // patch vendor
    const SCALAR = ["vendor_cn","province","currency","notes"];
    const JSONB  = ["surge","raw"];
    const sets = [], vals = [];
    for (const k of SCALAR) {
      if (patch[k] !== undefined) { vals.push(patch[k]); sets.push(`${k}=$${vals.length}`); }
    }
    for (const k of JSONB) {
      if (patch[k] !== undefined) { vals.push(JSON.stringify(patch[k])); sets.push(`${k}=$${vals.length}::jsonb`); }
    }
    if (!sets.length) return res.status(400).json({ error: "nothing to update" });
    sets.push("updated_at=now()"); vals.push(_id);
    try {
      const r = await pool.query(
        `UPDATE trucking_vendors SET ${sets.join(",")} WHERE _id=$${vals.length} RETURNING *`, vals
      );
      if (!r.rowCount) return res.status(404).json({ error: "vendor not found" });
      return res.json({ success: true, data: r.rows[0] });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  }

  // ── DELETE: vendor (cascades) or route ──
  if (req.method === "DELETE") {
    if (!requireAuth(req, res)) return;
    const { _type, _id } = req.body || {};
    if (!_id) return res.status(400).json({ error: "_id required" });
    const table = _type === "route" ? "trucking_routes" : "trucking_vendors";
    try {
      const r = await pool.query(`DELETE FROM ${table} WHERE _id=$1`, [_id]);
      if (!r.rowCount) return res.status(404).json({ error: "not found" });
      return res.json({ success: true });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  }

  return res.status(405).json({ error: "method not allowed" });
}
