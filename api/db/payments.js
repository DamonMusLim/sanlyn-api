import { getPool, setCors } from "../db.js";
export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const pool = getPool();
    const { customer, status, plan_id, limit = 500 } = req.query;
    let query = "SELECT * FROM finance_payments", params = [], conds = [];
    if (customer) { params.push(`%${customer}%`); conds.push(`customer ILIKE $${params.length}`); }
    if (status) { params.push(status); conds.push(`status = $${params.length}`); }
    if (plan_id) { params.push(plan_id); conds.push(`plan_id = $${params.length}`); }
    if (conds.length) query += " WHERE " + conds.join(" AND ");
    params.push(parseInt(limit));
    query += ` ORDER BY created_at DESC LIMIT $${params.length}`;
    const result = await pool.query(query, params);
    return res.status(200).json({ success: true, data: result.rows, count: result.rowCount });
  } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
}
