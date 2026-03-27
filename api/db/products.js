import { getPool, setCors } from "../db.js";
export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const pool = getPool();
    const { brand, category, search, limit = 1000 } = req.query;

    let query = "SELECT * FROM products", params = [], conds = [];

    if (brand) {
      params.push(brand);
      conds.push(`(brand = $${params.length} OR raw->>'brand' = $${params.length})`);
    }
    if (category) {
      params.push(category);
      conds.push(`(category = $${params.length} OR raw->>'cat1' = $${params.length})`);
    }
    if (search) {
      params.push(`%${search}%`);
      conds.push(`(sku ILIKE $${params.length} OR product_name ILIKE $${params.length} OR product_name_cn ILIKE $${params.length})`);
    }

    if (conds.length) query += " WHERE " + conds.join(" AND ");
    params.push(parseInt(limit));
    query += ` ORDER BY id DESC LIMIT $${params.length}`;

    const result = await pool.query(query, params);
    return res.status(200).json({ data: result.rows, count: result.rows.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
