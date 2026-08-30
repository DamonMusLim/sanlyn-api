import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 分类动销排行。⛔ 源表 petstore_sku_sales_dna 里有 cost_price / gross_margin_pct /
//    gross_profit_90,本接口【一个都不查出来】——jdc 前端不许拿到成本。
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function cleanText(value, max = 120) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}

function positiveInt(value, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function paging(query) {
  const page = positiveInt(query?.page, DEFAULT_PAGE);
  const pageSize = Math.min(positiveInt(query?.pageSize, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function json(res, status, data) {
  return res.status(status).json(data);
}

async function listRows(req) {
  const { page, pageSize, offset } = paging(req.query || {});
  const storeCode = cleanText(req.query?.store_code, 80);
  const categoryName = cleanText(req.query?.category_name, 120);
  const params = [storeCode, categoryName, pageSize, offset];

  // 三个指标的口径:
  //   销售额     = qty_30 * out_price(近30天数量 × 售价)
  //   销售占比   = 本分类销售额 / 全部分类销售额
  //   在售率     = 有库存的 SKU 数 / 本分类 SKU 总数
  //   动销率     = 近30天有销量的 SKU 数 / 本分类 SKU 总数
  const sql = `
    WITH base AS (
      SELECT category_name,
             product_code,
             COALESCE(qty_30, 0)     AS qty_30,
             COALESCE(cur_stock, 0)  AS cur_stock,
             COALESCE(out_price, 0)  AS out_price
        FROM public.petstore_sku_sales_dna
       WHERE ($1::text IS NULL OR store_code = $1)
         AND ($2::text IS NULL OR category_name ILIKE '%' || $2 || '%')
         AND category_name IS NOT NULL
    ), per_cat AS (
      SELECT category_name,
             COUNT(*)::int                                              AS sku_total,
             COUNT(*) FILTER (WHERE cur_stock > 0)::int                 AS sku_in_stock,
             COUNT(*) FILTER (WHERE qty_30 > 0)::int                    AS sku_moving,
             SUM(qty_30)::numeric                                       AS qty_30,
             SUM(cur_stock)::numeric                                    AS cur_stock,
             SUM(qty_30 * out_price)::numeric                           AS sales_amount
        FROM base
       GROUP BY category_name
    ), total AS (
      SELECT NULLIF(SUM(sales_amount), 0) AS all_sales FROM per_cat
    ), scored AS (
      SELECT p.category_name,
             p.sku_total, p.sku_in_stock, p.sku_moving,
             p.qty_30, p.cur_stock,
             ROUND(p.sales_amount, 2)                                            AS sales_amount,
             ROUND(100 * p.sales_amount / t.all_sales, 2)                         AS sales_share_pct,
             ROUND(100.0 * p.sku_in_stock / NULLIF(p.sku_total, 0), 2)            AS on_sale_pct,
             ROUND(100.0 * p.sku_moving   / NULLIF(p.sku_total, 0), 2)            AS moving_pct
        FROM per_cat p CROSS JOIN total t
    ), total_count AS (
      SELECT COUNT(*)::int AS total FROM scored
    ), page_rows AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY sales_amount DESC NULLS LAST, category_name ASC) AS __rn FROM scored
       ORDER BY sales_amount DESC NULLS LAST, category_name ASC
       LIMIT $3 OFFSET $4
    )
    SELECT COALESCE(
             jsonb_agg(to_jsonb(page_rows) - '__rn' ORDER BY page_rows.__rn) FILTER (WHERE page_rows.category_name IS NOT NULL),
             '[]'::jsonb
           ) AS rows,
           total_count.total
      FROM total_count
      LEFT JOIN page_rows ON true
     GROUP BY total_count.total`;

  const result = await getPool().query(sql, params);
  const first = result.rows[0] || { rows: [], total: 0 };
  return { rows: first.rows, total: first.total, page, pageSize };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (!requireAuth(req, res)) return;
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });
    return json(res, 200, await listRows(req));
  } catch (err) {
    return json(res, 500, { ok: false, error: err.message || "server_error" });
  }
}
