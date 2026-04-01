import { getPool, setCors } from "../db.js";
export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const pool = getPool();
    const joinSQL = `
      SELECT a.*, c.allowed_brands, c.factory_name, c.group_code
      FROM accounts a
      LEFT JOIN companies c ON a.company_code = c.code
    `;
    if (req.method === "GET") {
      const { username, role, limit = 200 } = req.query;
      let query = joinSQL, params = [], conds = [];
      if (username) { params.push(username); conds.push(`a.username = $${params.length}`); }
      if (role)     { params.push(role);     conds.push(`a.role = $${params.length}`); }
      if (conds.length) query += " WHERE " + conds.join(" AND ");
      params.push(parseInt(limit));
      query += ` ORDER BY a.created_at DESC LIMIT $${params.length}`;
      const result = await pool.query(query, params);
      return res.status(200).json({ success: true, data: result.rows, count: result.rowCount });
    }
    if (req.method === "POST") {
      const { username, password } = req.body || {};
      if (!username || !password) return res.status(400).json({ success: false, error: "Missing credentials" });
      const result = await pool.query(
        joinSQL + " WHERE a.username = $1 AND a.password = $2 LIMIT 1",
        [username, password]
      );
      if (result.rowCount === 0) return res.status(401).json({ success: false, error: "Invalid credentials" });
      return res.status(200).json({ success: true, data: result.rows[0] });
    }
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
}
