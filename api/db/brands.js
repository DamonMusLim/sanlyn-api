import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT code, name, owner_company_code, default_export_seller_code, active
         FROM brands
        ORDER BY code ASC`
    );
    return res.status(200).json({
      success: true,
      data: result.rows,
      count: result.rowCount,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
