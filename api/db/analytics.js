import { getPool, setCors } from "../db.js";
export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const pool = getPool();
    const { type, customer } = req.query;
    if (type === "customer360") {
      const params = customer ? [`%${customer}%`] : [];
      const where = customer ? "WHERE o.customer ILIKE $1" : "";
      const result = await pool.query(`
        SELECT o.customer, COUNT(*) AS order_count,
          SUM(CAST(o.total_amount AS NUMERIC)) AS total_amount,
          COALESCE(SUM(CAST(p.raw->>'receivedAmount' AS NUMERIC)),0) AS total_received,
          SUM(CAST(o.total_amount AS NUMERIC)) - COALESCE(SUM(CAST(p.raw->>'receivedAmount' AS NUMERIC)),0) AS outstanding
        FROM orders o LEFT JOIN finance_payments p ON o._id = p._id
        ${where} GROUP BY o.customer ORDER BY total_amount DESC NULLS LAST LIMIT 50
      `, params);
      return res.status(200).json({ success: true, data: result.rows });
    }
    if (type === "monthly") {
      const result = await pool.query(`
        SELECT TO_CHAR(created_at,'YYYY-MM') AS month, COUNT(*) AS order_count,
          SUM(CAST(total_amount AS NUMERIC)) AS total_amount, currency
        FROM orders WHERE created_at IS NOT NULL
        GROUP BY TO_CHAR(created_at,'YYYY-MM'), currency ORDER BY month DESC LIMIT 24
      `);
      return res.status(200).json({ success: true, data: result.rows });
    }
    if (type === "receivables") {
      const result = await pool.query(`
        SELECT o._id AS contract_no, o.customer,
          CAST(o.total_amount AS NUMERIC) AS invoiced,
          COALESCE(CAST(p.raw->>'receivedAmount' AS NUMERIC),0) AS received,
          CAST(o.total_amount AS NUMERIC) - COALESCE(CAST(p.raw->>'receivedAmount' AS NUMERIC),0) AS outstanding,
          o.currency, o.created_at
        FROM orders o LEFT JOIN finance_payments p ON o._id = p._id
        WHERE CAST(o.total_amount AS NUMERIC) > 0
          AND (p._id IS NULL OR CAST(o.total_amount AS NUMERIC) > COALESCE(CAST(p.raw->>'receivedAmount' AS NUMERIC),0))
        ORDER BY outstanding DESC NULLS LAST LIMIT 100
      `);
      return res.status(200).json({ success: true, data: result.rows, count: result.rowCount });
    }
    return res.status(400).json({ error: "type must be: customer360, monthly, receivables" });
  } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
}
