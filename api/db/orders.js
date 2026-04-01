import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const pool = getPool();
    const { customer, status, limit = 500, brands } = req.query;
    let query = "SELECT * FROM orders", params = [], conds = [];

    if (customer) { params.push(`%${customer}%`); conds.push(`customer ILIKE $${params.length}`); }
    if (status)   { params.push(status);           conds.push(`status = $${params.length}`); }

    // Brand filtering for factory accounts
    if (brands) {
      let brandList;
      try { brandList = JSON.parse(brands); } catch { brandList = [brands]; }
      if (brandList.length > 0) {
        const orClauses = [];
        // 方式1: JDY brand widget字段 (新订单同步后生效)
        brandList.forEach(brand => {
          params.push(brand);
          orClauses.push(`raw->>'_widget_1775071325804' = $${params.length}`);
        });
        // 方式2: 产品名ILIKE (当前订单的兜底方案)
        brandList.forEach(brand => {
          params.push(`%${brand}%`);
          orClauses.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(raw->'products') p WHERE p->>'name' ILIKE $${params.length})`);
        });
        conds.push(`(${orClauses.join(' OR ')})`);
      }
    }

    if (conds.length) query += " WHERE " + conds.join(" AND ");
    params.push(parseInt(limit));
    query += ` ORDER BY created_at DESC LIMIT $${params.length}`;
    const result = await pool.query(query, params);
    return res.status(200).json({ success: true, data: result.rows, count: result.rowCount });
  } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
}
