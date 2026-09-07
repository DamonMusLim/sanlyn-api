import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 🔴 本接口永不返回成本类字段(cost_price / gross_margin / gross_profit_margin / 进价)。
//    成本红线 = 成本不出库,前端「门店进价」「毛利」两列固定显示「成本不出库」。
//    加字段前先确认不是成本口径。
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
  const keyword = cleanText(req.query?.keyword, 120);
  const category = cleanText(req.query?.category, 120);
  const productStatus = cleanText(req.query?.product_status, 80);
  // stock=instock 时只返回有货的;其它任何值(含不传)= 全部 = 原行为。
  // ⛔ 默认必须是全部 —— 这个接口还有别的页面在用。
  const stock = cleanText(req.query?.stock, 40) === "instock" ? "instock" : null;
  const params = [keyword, category, productStatus, pageSize, offset, stock];
  const sql = `
    WITH sku_key_check AS (
      SELECT 1 / CASE WHEN COUNT(*) = COUNT(DISTINCT product_code) THEN 1 ELSE 0 END AS ok
        FROM public.petstore_skus
    ), filtered AS (
      SELECT r.product_code, r.barcode, r.product_name, r.category, r.spec_text, r.pic_url,
             r.store_price, r.mt_price, r.ele_price, r.cur_stock, r.product_status, r.shelf_code,
             k.month_sale AS month_sale,
             k.warn_status AS warn_status,
             k.category_l1 AS category_l1,
             k.category_l2 AS category_l2,
             k.spu_code AS spu_code,
             k.stock_num AS stock_num,
             k.out_price AS out_price,
             k.supplier AS supplier,
             k.take_out AS take_out,
             k.gdc_created_at AS gdc_created_at,
             k.gdc_updated_at AS gdc_updated_at,
             k.gdc_created_by AS gdc_created_by,
             k.gdc_updated_by AS gdc_updated_by,
             -- 效期真源:petstore_offline_expiry_snapshot(718行,product_code唯一)
             -- 🔴 没日期的商品这四列必须是 null,⛔不许填0/今天/空串 ——「没有」和「取不到」要分得开
             e.produce_date AS produce_date,
             e.expiration_date AS expiration_date,
             (e.expiration_date - current_date)::int AS days_to_expire,  -- 负数=已过期,⛔不clamp
             e.capture_date AS expiry_captured
        FROM public.petstore_ops_row r
        CROSS JOIN sku_key_check
        LEFT JOIN public.petstore_skus k ON k.product_code = r.product_code
        LEFT JOIN public.petstore_offline_expiry_snapshot e ON e.product_code = r.product_code
       WHERE (
             $1::text IS NULL
          OR r.product_code ILIKE '%' || $1 || '%'
          OR r.barcode ILIKE '%' || $1 || '%'
          OR r.product_name ILIKE '%' || $1 || '%'
       )
         AND ($2::text IS NULL OR r.category = $2)
         AND ($3::text IS NULL OR r.product_status = $3)
         -- 有货 = 两个库存源【任一边】说有货。实测两源有47行互相矛盾,
         -- 宁可多显示也不许误藏 —— 藏错了店员就漏了补货。
         AND ($6::text IS NULL OR GREATEST(COALESCE(k.stock_num,0), COALESCE(r.cur_stock,0)) > 0)
    ), total_count AS (
      SELECT COUNT(*)::int AS total FROM filtered
    ), summary_stats AS (
      SELECT COUNT(*)::int AS sku_total,
             COALESCE(SUM(stock_num), 0) AS stock_total,
             COALESCE(SUM(stock_num * out_price), 0) AS sale_total,
             COUNT(DISTINCT spu_code)::int AS spu_total,
             COUNT(*) FILTER (WHERE expiration_date IS NOT NULL)::int AS expiry_covered,
             MAX(expiry_captured) AS expiry_captured
        FROM filtered
    ), spu_page AS (
      SELECT DISTINCT spu_code
        FROM filtered
       ORDER BY spu_code
       LIMIT $4 OFFSET $5
    ), page_rows AS (
      SELECT product_code, barcode, product_name, category, spec_text, pic_url,
             gdc_created_at, gdc_updated_at,
             store_price, mt_price, ele_price, cur_stock, product_status, shelf_code,
             month_sale, warn_status, category_l1, category_l2, spu_code,
             produce_date, expiration_date, days_to_expire, expiry_captured,
             stock_num, out_price, supplier, take_out,
             gdc_created_at, gdc_updated_at, gdc_created_by, gdc_updated_by
        FROM filtered
       WHERE spu_code IN (SELECT spu_code FROM spu_page)
    )
    SELECT COALESCE(
             jsonb_agg(to_jsonb(page_rows) ORDER BY page_rows.spu_code, page_rows.product_code, page_rows.spec_text)
               FILTER (WHERE page_rows.product_code IS NOT NULL),
             '[]'::jsonb
           ) AS rows,
           total_count.total,
           jsonb_build_object(
             'sku_total', summary_stats.sku_total,
             'stock_total', summary_stats.stock_total,
             'sale_total', summary_stats.sale_total,
             'spu_total', summary_stats.spu_total,
             'expiry_covered', summary_stats.expiry_covered,
             'expiry_captured', summary_stats.expiry_captured
           ) AS summary
      FROM total_count
      CROSS JOIN summary_stats
      LEFT JOIN page_rows ON true
     GROUP BY total_count.total,
              summary_stats.sku_total,
              summary_stats.stock_total,
              summary_stats.sale_total,
              summary_stats.spu_total,
              summary_stats.expiry_covered,
              summary_stats.expiry_captured`;
  const result = await getPool().query(sql, params);
  const first = result.rows[0] || {
    rows: [],
    total: 0,
    summary: { sku_total: 0, stock_total: 0, sale_total: 0, spu_total: 0,
               expiry_covered: 0, expiry_captured: null },
  };
  return { rows: first.rows, total: first.total, page, pageSize, summary: first.summary };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    // 0907:数据加工中心(/dataops/)走 nginx auth_request 网关鉴权,不带 JWT。
  // 同名头在 /api/db/petstore- 那条口被 nginx 清空,外部伪造不进来(0907 实证)。
  if (req.headers["x-gateway-auth"] !== "gw-dataops-0903") { if (!requireAuth(req, res)) return; }
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });
    return json(res, 200, await listRows(req));
  } catch (err) {
    console.error("[petstore-goods-list]", err);
    return json(res, 500, { ok: false, error: "server_error" });
  }
}
