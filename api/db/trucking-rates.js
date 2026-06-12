// /api/db/trucking-rates.js — 拖车费率 CRUD（对齐真实DB schema）
// DB: trucking_rates(_id uuid, vendor_cn, factory_name, pol, valid_from, valid_to,
//                   rates jsonb, surge jsonb, currency, notes, raw, created_at, updated_at)
import { getPool, setCors } from "./db.js";
import { requireAuth } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();

  // GET — list / filter
  if (req.method === "GET") {
    try {
      const { pol, vendor_cn, factory_name, limit = 1000 } = req.query;
      let query = "SELECT * FROM trucking_rates", params = [], conds = [];
      if (pol)          { params.push(`%${pol}%`);          conds.push(`pol ILIKE $${params.length}`); }
      if (vendor_cn)    { params.push(`%${vendor_cn}%`);    conds.push(`vendor_cn ILIKE $${params.length}`); }
      if (factory_name) { params.push(`%${factory_name}%`); conds.push(`factory_name ILIKE $${params.length}`); }
      if (conds.length) query += " WHERE " + conds.join(" AND ");
      params.push(parseInt(limit));
      query += ` ORDER BY pol ASC, vendor_cn ASC LIMIT $${params.length}`;
      const result = await pool.query(query, params);
      return res.status(200).json({ success: true, data: result.rows, count: result.rowCount });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // POST — create
  if (req.method === "POST") {
    if (!requireAuth(req, res)) return;
    try {
      const { vendor_cn, factory_name, pol, valid_from, valid_to, rates, surge, currency, notes, raw } = req.body || {};
      const r = await pool.query(
        `INSERT INTO trucking_rates(vendor_cn,factory_name,pol,valid_from,valid_to,rates,surge,currency,notes,raw)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10::jsonb) RETURNING *`,
        [
          vendor_cn || null, factory_name || null, pol || null,
          valid_from || null, valid_to || null,
          JSON.stringify(rates || {}), JSON.stringify(surge || {}),
          currency || "CNY", notes || null,
          JSON.stringify(raw || null)
        ]
      );
      return res.status(201).json({ success: true, data: r.rows[0] });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // PATCH — update by _id
  if (req.method === "PATCH") {
    if (!requireAuth(req, res)) return;
    try {
      const { _id, ...patch } = req.body || {};
      if (!_id) return res.status(400).json({ error: "_id required" });
      const SCALAR  = ["vendor_cn","factory_name","pol","valid_from","valid_to","currency","notes"];
      const JSONB   = ["rates","surge","raw"];
      const sets = [], vals = [];
      for (const k of SCALAR) {
        if (patch[k] !== undefined) { vals.push(patch[k]); sets.push(`${k} = $${vals.length}`); }
      }
      for (const k of JSONB) {
        if (patch[k] !== undefined) { vals.push(JSON.stringify(patch[k])); sets.push(`${k} = $${vals.length}::jsonb`); }
      }
      if (!sets.length) return res.status(400).json({ error: "no fields to update" });
      vals.push(_id);
      sets.push("updated_at = now()");
      const r = await pool.query(
        `UPDATE trucking_rates SET ${sets.join(", ")} WHERE _id = $${vals.length} RETURNING *`, vals
      );
      if (!r.rowCount) return res.status(404).json({ error: "record not found" });
      return res.status(200).json({ success: true, data: r.rows[0] });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // DELETE — by _id
  if (req.method === "DELETE") {
    if (!requireAuth(req, res)) return;
    try {
      const id = req.query._id || req.body?._id;
      if (!id) return res.status(400).json({ error: "_id required" });
      const r = await pool.query("DELETE FROM trucking_rates WHERE _id = $1", [id]);
      if (!r.rowCount) return res.status(404).json({ error: "record not found" });
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
