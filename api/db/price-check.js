// /api/db/price-check.js — 价格一致性校验
// GET  ?order_id=xxx   → 对比 order_line_items.unit_price vs products.sale_price_cny
// GET  ?order_ids=1,2  → 批量校验多个订单
// Returns { ok, warnings: [{ id, order_id, sku, product_name, unit_price, master_price, diff, diff_pct }] }
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  var pool = getPool();

  var orderIds = [];
  if (req.query.order_id) {
    var id = parseInt(req.query.order_id);
    if (id) orderIds.push(id);
  }
  if (req.query.order_ids) {
    req.query.order_ids.split(",").forEach(function(s) {
      var id = parseInt(s.trim());
      if (id) orderIds.push(id);
    });
  }
  if (!orderIds.length) return res.status(400).json({ error: "order_id or order_ids required" });

  try {
    // Join order_line_items with products to get master sale_price_cny
    var r = await pool.query(
      `SELECT
         oli.id, oli.order_id, oli.sku, oli.product_name,
         oli.unit_price,
         p.sale_price_cny AS master_price,
         o.order_no
       FROM order_line_items oli
       JOIN orders o ON o.id = oli.order_id
       LEFT JOIN products p ON p.sku = oli.sku AND p.active = true
       WHERE oli.order_id = ANY($1::int[])
       ORDER BY oli.order_id, oli.sort_order, oli.id`,
      [orderIds]
    );

    var warnings = [];
    var skipped = [];  // items without SKU (DG orders etc.)

    r.rows.forEach(function(row) {
      // No SKU = 代购/DG, skip price check
      if (!row.sku) {
        skipped.push({ order_id: row.order_id, order_no: row.order_no, product_name: row.product_name, reason: "no_sku" });
        return;
      }
      // No master price = products table not populated yet
      if (row.master_price === null || row.master_price === undefined) {
        warnings.push({
          id: row.id,
          order_id: row.order_id,
          order_no: row.order_no,
          sku: row.sku,
          product_name: row.product_name,
          unit_price: parseFloat(row.unit_price) || 0,
          master_price: null,
          diff: null,
          diff_pct: null,
          issue: "master_price_missing",
          message: "products.sale_price_cny 未设置，无法校验",
        });
        return;
      }

      var up = parseFloat(row.unit_price) || 0;
      var mp = parseFloat(row.master_price) || 0;
      var diff = parseFloat((up - mp).toFixed(4));
      var diff_pct = mp > 0 ? parseFloat(((up - mp) / mp * 100).toFixed(2)) : null;

      // Tolerance: within 0.1% is OK (floating point / rounding)
      if (Math.abs(diff) > 0.01) {
        warnings.push({
          id: row.id,
          order_id: row.order_id,
          order_no: row.order_no,
          sku: row.sku,
          product_name: row.product_name,
          unit_price: up,
          master_price: mp,
          diff: diff,
          diff_pct: diff_pct,
          issue: "price_mismatch",
          message: `单价 ${up} ≠ 产品表 ${mp}，偏差 ${diff_pct !== null ? diff_pct + "%" : "-"}`,
        });
      }
    });

    return res.status(200).json({
      ok: warnings.length === 0,
      order_ids: orderIds,
      total_lines: r.rows.length,
      skipped_count: skipped.length,
      warning_count: warnings.length,
      warnings,
      skipped,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
