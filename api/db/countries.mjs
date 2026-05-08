// /api/db/countries.mjs — Countries master data CRUD
import { getPool, setCors } from "./db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();

  if (req.method === "GET") {
    try {
      const { region, sanlyn_market, limit = 1000 } = req.query;
      let query = "SELECT * FROM countries", params = [], conds = [];
      if (region) { params.push(region); conds.push(`region = $${params.length}`); }
      if (sanlyn_market !== undefined) {
        params.push(sanlyn_market === "true" || sanlyn_market === "1");
        conds.push(`sanlyn_market = $${params.length}`);
      }
      if (conds.length) query += " WHERE " + conds.join(" AND ");
      params.push(parseInt(limit));
      query += ` ORDER BY name_en ASC LIMIT $${params.length}`;
      const result = await pool.query(query, params);
      return res.status(200).json({ success: true, data: result.rows, count: result.rowCount });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (req.method === "POST") {
    try {
      const { code, code3, name_en, name_cn, currency, region, flag_emoji, sanlyn_market, notes } = req.body || {};
      if (!code || !name_en) return res.status(400).json({ error: "code and name_en required" });
      const r = await pool.query(
        `INSERT INTO countries(code,code3,name_en,name_cn,currency,region,flag_emoji,sanlyn_market,notes)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [code.toUpperCase(), code3||null, name_en, name_cn||null, currency||null, region||null, flag_emoji||null, sanlyn_market||false, notes||null]
      );
      return res.status(201).json({ success: true, data: r.rows[0] });
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: "Country code already exists" });
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (req.method === "PATCH") {
    try {
      const { code, ...patch } = req.body || {};
      if (!code) return res.status(400).json({ error: "code required" });
      const allowed = ["code3","name_en","name_cn","currency","region","flag_emoji","sanlyn_market","notes"];
      const sets = [], vals = [];
      for (const k of allowed) {
        if (patch[k] !== undefined) { vals.push(patch[k]); sets.push(`${k} = $${vals.length}`); }
      }
      if (!sets.length) return res.status(400).json({ error: "no fields to update" });
      vals.push(code.toUpperCase());
      const r = await pool.query(
        `UPDATE countries SET ${sets.join(", ")} WHERE code = $${vals.length} RETURNING *`, vals
      );
      if (!r.rowCount) return res.status(404).json({ error: "country not found" });
      return res.status(200).json({ success: true, data: r.rows[0] });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (req.method === "DELETE") {
    try {
      const code = req.query.code || req.body?.code;
      if (!code) return res.status(400).json({ error: "code required" });
      const r = await pool.query("DELETE FROM countries WHERE code = $1", [code.toUpperCase()]);
      if (!r.rowCount) return res.status(404).json({ error: "country not found" });
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
