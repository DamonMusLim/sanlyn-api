// 锁价名单(只读) —— 任何自动调价跑之前必须先拉这张表
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  try {
    const r = await getPool().query(
      `SELECT product_code, product_name, reason, locked_by, locked_at
         FROM petstore_price_lock WHERE locked = true ORDER BY locked_at DESC`);
    res.status(200).json({ success: true, data: r.rows, count: r.rowCount });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
}
