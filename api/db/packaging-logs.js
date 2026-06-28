// /api/db/packaging-logs.js — 包材库存变动日志查询
import { getPool, setCors } from "./db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET only" });

  const pool = getPool();
  try {
    const { material_id, limit = 100 } = req.query;
    if (!material_id) return res.status(400).json({ success: false, error: "material_id required" });
    const r = await pool.query(
      `SELECT l.*, m.name as material_name, m.sku_code
       FROM packaging_logs l
       LEFT JOIN packaging_materials m ON m.id = l.material_id
       WHERE l.material_id = $1
       ORDER BY l.created_at DESC
       LIMIT $2`,
      [material_id, parseInt(limit)]
    );
    return res.status(200).json({ success: true, data: r.rows, count: r.rowCount });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
