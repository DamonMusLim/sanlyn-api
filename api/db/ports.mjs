// /api/db/ports.mjs — Ports master data CRUD
import { getPool, setCors } from "./db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();

  if (req.method === "GET") {
    try {
      const { country_code, port_type, limit = 1000 } = req.query;
      let query = "SELECT * FROM ports", params = [], conds = [];
      if (country_code) { params.push(country_code.toUpperCase()); conds.push(`country_code = $${params.length}`); }
      if (port_type) { params.push(port_type); conds.push(`port_type = $${params.length}`); }
      if (conds.length) query += " WHERE " + conds.join(" AND ");
      params.push(parseInt(limit));
      query += ` ORDER BY country_code ASC, name_en ASC LIMIT $${params.length}`;
      const result = await pool.query(query, params);
      return res.status(200).json({ success: true, data: result.rows, count: result.rowCount });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (req.method === "POST") {
    try {
      const { code, name_en, name_cn, country_code, port_type, unlocode, note } = req.body || {};
      if (!code || !name_en) return res.status(400).json({ error: "code and name_en required" });
      const r = await pool.query(
        `INSERT INTO ports(code,name_en,name_cn,country_code,port_type,unlocode,note)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [code.toUpperCase(), name_en, name_cn||null, (country_code||null)&&country_code.toUpperCase(), port_type||'sea', unlocode||null, note||null]
      );
      return res.status(201).json({ success: true, data: r.rows[0] });
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: "Port code already exists" });
      if (err.code === "23503") return res.status(400).json({ error: "country_code not in countries master" });
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (req.method === "PATCH") {
    try {
      const { code, ...patch } = req.body || {};
      if (!code) return res.status(400).json({ error: "code required" });
      const allowed = ["name_en","name_cn","country_code","port_type","unlocode","note"];
      const sets = [], vals = [];
      for (const k of allowed) {
        if (patch[k] !== undefined) { vals.push(k==="country_code"&&patch[k]?String(patch[k]).toUpperCase():patch[k]); sets.push(`${k} = $${vals.length}`); }
      }
      if (!sets.length) return res.status(400).json({ error: "no fields to update" });
      vals.push(code.toUpperCase());
      const r = await pool.query(`UPDATE ports SET ${sets.join(", ")}, updated_at=now() WHERE code = $${vals.length} RETURNING *`, vals);
      if (!r.rowCount) return res.status(404).json({ error: "port not found" });
      return res.status(200).json({ success: true, data: r.rows[0] });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (req.method === "DELETE") {
    try {
      const code = req.query.code || req.body?.code;
      if (!code) return res.status(400).json({ error: "code required" });
      const r = await pool.query("DELETE FROM ports WHERE code = $1", [code.toUpperCase()]);
      if (!r.rowCount) return res.status(404).json({ error: "port not found" });
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
