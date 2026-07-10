// /api/db/finished-goods-logs.js — Finished goods inventory log query
import { getPool, setCors } from "./db.js";

function parseLimit(v) {
  const n = parseInt(v || 100, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1000) : 100;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET only" });

  const pool = getPool();
  try {
    const { product_id, sku, type, date_from, date_to, warehouse_id, limit = 100 } = req.query;
    const params = [], conds = [];
    if (product_id) { params.push(product_id); conds.push(`l.product_id = $${params.length}`); }
    if (sku) { params.push(`%${sku}%`); conds.push(`l.sku ILIKE $${params.length}`); }
    if (type) { params.push(type); conds.push(`l.type = $${params.length}`); }
    if (warehouse_id) { params.push(warehouse_id); conds.push(`l.warehouse_id = $${params.length}`); }
    if (date_from) { params.push(date_from); conds.push(`COALESCE(l.delivery_date, l.at::date) >= $${params.length}`); }
    if (date_to) { params.push(date_to); conds.push(`COALESCE(l.delivery_date, l.at::date) <= $${params.length}`); }

    let q = `
      SELECT l.*, p.product_name, p.product_name_cn, w.code AS warehouse_code, w.name AS warehouse_name
      FROM inventory_logs l
      LEFT JOIN products p ON p.id = l.product_id
      LEFT JOIN warehouses w ON w.id = l.warehouse_id`;
    if (conds.length) q += " WHERE " + conds.join(" AND ");
    params.push(parseLimit(limit));
    q += ` ORDER BY l.at DESC, l.id DESC LIMIT $${params.length}`;
    const r = await pool.query(q, params);
    return res.status(200).json({ success: true, data: r.rows, count: r.rowCount });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
