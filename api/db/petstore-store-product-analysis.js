import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 门店商品分析 —— 单店(金枋 63350001),只读汇总 1 行。
// 数据源只用 public.petstore_product_status_current 和 public.petstore_sku_sales_dna 最新快照。
// 动销必须用 sku_sales_dna.qty_30(滚动 30 天),不能用 product_status_current.month_sale_num(自然月)。
// 缺货 = 上架且无货;缺货率分母是上架商品数。
function json(res, s, d) { return res.status(s).json(d); }
function clean(v, m = 80) { const s = String(v ?? "").trim(); return s ? s.slice(0, m) : null; }

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (!requireAuth(req, res)) return;
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });

    const storeCode = clean(req.query?.store_code, 40) || "63350001";
    const sql = `
      WITH latest_dna AS (
        SELECT max(as_of) AS as_of FROM public.petstore_sku_sales_dna
      ), status_counts AS (
        SELECT $1::text AS store_code,
               COUNT(*)::int AS total_skus,
               COUNT(*) FILTER (WHERE p.stock_num > 0)::int AS in_stock_skus,
               COUNT(*) FILTER (WHERE p.product_status = 'UP')::int AS listed_skus,
               COUNT(*) FILTER (WHERE p.product_status = 'UP' AND COALESCE(p.stock_num, 0) <= 0)::int AS oos_skus
          FROM public.petstore_product_status_current p
         WHERE p.store_code = $1
      ), moving_counts AS (
        SELECT $1::text AS store_code,
               COUNT(*) FILTER (WHERE s.qty_30 > 0)::int AS moving_skus
          FROM public.petstore_sku_sales_dna s
          JOIN latest_dna l ON l.as_of = s.as_of
         WHERE s.store_code = $1
      )
      SELECT sc.store_code,
             sc.total_skus,
             sc.in_stock_skus,
             ROUND(sc.in_stock_skus * 100.0 / NULLIF(sc.total_skus, 0), 1)::float8 AS in_stock_rate,
             sc.listed_skus,
             ROUND(sc.listed_skus * 100.0 / NULLIF(sc.total_skus, 0), 1)::float8 AS listed_rate,
             COALESCE(mc.moving_skus, 0)::int AS moving_skus,
             ROUND(COALESCE(mc.moving_skus, 0) * 100.0 / NULLIF(sc.total_skus, 0), 1)::float8 AS moving_rate,
             sc.oos_skus,
             ROUND(sc.oos_skus * 100.0 / NULLIF(sc.listed_skus, 0), 1)::float8 AS oos_rate
        FROM status_counts sc
        LEFT JOIN moving_counts mc ON mc.store_code = sc.store_code`;

    const r = await getPool().query(sql, [storeCode]);
    return json(res, 200, { rows: r.rows, total: 1 });
  } catch (e) { return json(res, 500, { error: e.message || "server_error" }); }
}
