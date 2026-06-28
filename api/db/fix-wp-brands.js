// fix-wp-brands.js — 一次性修复 WP 订单 brand 字段
// GET /api/db/fix-wp-brands  (admin only)
import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!req.user || req.user.role !== "admin") return res.status(403).json({ error: "admin only" });

  var pool = getPool();
  var log = [];

  // 37-WP 系列 → DOGSOME（CN-00037 PETSOME SDN BHD 实际品牌）
  var r1 = await pool.query(
    `UPDATE orders SET brand = 'DOGSOME', updated_at = NOW()
     WHERE order_no ILIKE '37-WP-%' AND brand = 'DOGSOME / JERKYTIME / SNIFLLY'
     RETURNING order_no, brand`
  );
  log.push("37-WP fixed (" + r1.rowCount + " orders): " + r1.rows.map(function(r){return r.order_no;}).join(", "));

  // 37-wp-52 (lowercase)
  var r2 = await pool.query(
    `UPDATE orders SET brand = 'DOGSOME', updated_at = NOW()
     WHERE order_no = '37-wp-52' AND brand = 'DOGSOME / JERKYTIME / SNIFLLY'
     RETURNING order_no, brand`
  );
  log.push("37-wp-52 fixed (" + r2.rowCount + " orders)");

  // 38-wp-57 → SNIFFLY（CN-00038 PETSOME EU 实际品牌）
  var r3 = await pool.query(
    `UPDATE orders SET brand = 'SNIFFLY', updated_at = NOW()
     WHERE order_no ILIKE '38-wp-57' AND brand = 'DOGSOME / JERKYTIME / SNIFLLY'
     RETURNING order_no, brand`
  );
  log.push("38-wp-57 fixed (" + r3.rowCount + " orders): SNIFFLY");

  // 验证
  var check = await pool.query(
    `SELECT order_no, brand FROM orders
     WHERE order_no ILIKE '%-WP-%' OR order_no ILIKE '%-wp-%'
     ORDER BY order_no`
  );
  log.push("--- Final state ---");
  check.rows.forEach(function(r) { log.push(r.order_no + " → " + r.brand); });

  return res.status(200).json({ success: true, log });
}
