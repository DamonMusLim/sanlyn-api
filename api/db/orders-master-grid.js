// 订单主表 · 数据管理密网格 API(只读)
// ⚖️ Damon 0812 拿 jdy 数据管理截图点名:「这是真正的表格」「订单主表先做成熟」。
//    forge 假完成被查实(零提交零部署) → Claude 接管。
// 铁律:真源 postgres 只读;订单域行项目就取 order_line_items(OLI 禁令只限退税计算);
//      空就是空,不在 SQL 里补 0。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export async function loadOrdersMasterGrid(pool, q = {}) {
  const from = String(q.from || "2025-10-01").trim();
  const sql = `
SELECT o.id, o.order_no, o.contract_no, o.customer_po, o.status,
  COALESCE(NULLIF(o.company_name_en,''), NULLIF(o.customer,'')) AS customer,
  COALESCE(NULLIF(o.factory,''),(SELECT c.name_cn FROM companies c WHERE c.id = o.factory_company_id LIMIT 1)) AS factory,
  o.total_amount, o.customer_amount, o.currency,
  to_char(o.created_at,'YYYY-MM-DD') AS created,
  o.bl_no,
  COALESCE((
    SELECT json_agg(json_build_object(
      'barcode', l.barcode, 'sku', l.sku, 'name', l.product_name,
      'size', l.size, 'qty', l.qty_ctn, 'price', l.unit_price,
      'subtotal', l.subtotal, 'nw', l.nw_ctn, 'gw', l.gw_ctn
    ) ORDER BY l.sort_order)
    FROM order_line_items l WHERE l.order_id = o.id
  ), '[]'::json) AS items
FROM orders o
WHERE o.created_at >= $1
ORDER BY o.created_at DESC`;
  const r = await pool.query(sql, [from]);
  return r.rows;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;
  try {
    const rows = await loadOrdersMasterGrid(getPool(), req.query);
    res.status(200).json({ success: true, data: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
