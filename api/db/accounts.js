import { getPool, setCors } from "../db.js";
export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const pool = getPool();
    if (req.method === "GET") {
      const { username, role, limit = 200 } = req.query;
      let query = "SELECT * FROM accounts", params = [], conds = [];
      if (username) { params.push(username); conds.push(`username = $${params.length}`); }
      if (role) { params.push(role); conds.push(`role = $${params.length}`); }
      if (conds.length) query += " WHERE " + conds.join(" AND ");
      params.push(parseInt(limit));
      query += ` ORDER BY created_at DESC LIMIT $${params.length}`;
      const result = await pool.query(query, params);
      return res.status(200).json({ success: true, data: result.rows, count: result.rowCount });
    }
    if (req.method === "POST") {
      const { username, password } = req.body || {};
      if (!username || !password) return res.status(400).json({ success: false, error: "Missing credentials" });
      const result = await pool.query("SELECT * FROM accounts WHERE username = $1 AND password = $2 LIMIT 1", [username, password]);
      if (result.rowCount === 0) return res.status(401).json({ success: false, error: "Invalid credentials" });
      return res.status(200).json({ success: true, data: result.rows[0] });
    }
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
}
