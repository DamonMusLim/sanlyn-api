// /api/db/forwarder-alert-rules.js — 货代预警规则 CRUD
import { getPool, setCors } from "./db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();

  if (req.method === "GET") {
    try {
      const { forwarder_name, active } = req.query;
      let q = "SELECT * FROM forwarder_alert_rules", params = [], conds = [];
      if (forwarder_name) { params.push(forwarder_name); conds.push(`forwarder_name = $${params.length}`); }
      if (active === "1") conds.push("active = true");
      if (conds.length) q += " WHERE " + conds.join(" AND ");
      q += " ORDER BY id DESC";
      const r = await pool.query(q, params);
      return res.status(200).json({ success: true, data: r.rows, count: r.rowCount });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  if (req.method === "POST") {
    try {
      const { forwarder_name, metric, threshold, comparison, action, active } = req.body || {};
      if (!metric || threshold == null) return res.status(400).json({ success: false, error: "metric and threshold required" });
      const r = await pool.query(
        `INSERT INTO forwarder_alert_rules(forwarder_name,metric,threshold,comparison,action,active)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [forwarder_name||null, metric, threshold, comparison||">", action||"notify", active !== false]
      );
      return res.status(201).json({ success: true, data: r.rows[0] });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  if (req.method === "PATCH") {
    try {
      const { id, ...fields } = req.body || {};
      if (!id) return res.status(400).json({ success: false, error: "id required" });
      const allowed = ["forwarder_name","metric","threshold","comparison","action","active"];
      const setClauses = [], params = [];
      for (const [k, v] of Object.entries(fields)) {
        if (!allowed.includes(k)) continue;
        params.push(v); setClauses.push(`${k} = $${params.length}`);
      }
      if (!setClauses.length) return res.status(400).json({ success: false, error: "no valid fields" });
      params.push(id);
      const r = await pool.query(`UPDATE forwarder_alert_rules SET ${setClauses.join(",")} WHERE id=$${params.length} RETURNING *`, params);
      return res.status(200).json({ success: true, data: r.rows[0] });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  if (req.method === "DELETE") {
    try {
      const id = req.query.id || req.body?.id;
      if (!id) return res.status(400).json({ success: false, error: "id required" });
      await pool.query("DELETE FROM forwarder_alert_rules WHERE id=$1", [id]);
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  return res.status(405).json({ success: false, error: "Method not allowed" });
}
