import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 商品主线 —— 喂 点选商品/商品边框/影响流量商品/辅助合并/回收站/商品差异 等页。
// 🔴 源表 petstore_skus 有 cost_price / gross_margin / supplier,
//    petstore_product_status_current 有 cost_price —— 【一个都不 SELECT】。
//    ⛔ 永远逐列列出,绝不 SELECT *。
const DEFAULT_PAGE = 1, DEFAULT_PAGE_SIZE = 50, MAX_PAGE_SIZE = 200;

// 视图白名单:值是【写死的 SQL 片段】,用户输入只能命中键,不能拼内容。
// 用 Object.create(null) 防原型链(0830 codex 抓到 kind=constructor 能拼函数体进 SQL)。
const VIEW_SQL = Object.assign(Object.create(null), {
  all:       "TRUE",
  onsale:    "s.stock_num > 0",
  nostock:   "COALESCE(s.stock_num,0) <= 0",
  nosale:    "COALESCE(s.month_sale,0) = 0",
  hot:       "COALESCE(s.month_sale,0) > 0",
  ownbrand:  "s.own_brand IS TRUE",
});

function cleanText(v, max = 120) { const s = String(v ?? "").trim(); return s ? s.slice(0, max) : null; }
function positiveInt(v, f) { const n = Number.parseInt(v ?? "", 10); return Number.isFinite(n) && n > 0 ? n : f; }
function paging(q) {
  const page = positiveInt(q?.page, DEFAULT_PAGE);
  const pageSize = Math.min(positiveInt(q?.pageSize, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  return { page, pageSize, offset: (page - 1) * pageSize };
}
function json(res, s, d) { return res.status(s).json(d); }

async function listRows(req) {
  const { page, pageSize, offset } = paging(req.query || {});
  const viewKey = cleanText(req.query?.view, 20);
  const viewClause = (viewKey && Object.hasOwn(VIEW_SQL, viewKey)) ? `AND (${VIEW_SQL[viewKey]})` : "";
  const params = [
    cleanText(req.query?.product_code, 120),
    cleanText(req.query?.product_name, 120),
    cleanText(req.query?.category, 120),
    pageSize, offset,
  ];
  const order = "s.month_sale DESC NULLS LAST, s.product_code ASC";
  const sql = `
    WITH filtered AS (
      SELECT s.product_code, s.product_name, s.category, s.spec,
             s.out_price, s.stock_num, s.month_sale, s.shelf_list,
             s.own_brand, s.no_sale_months, s.snapshot_date,
             c.product_status, c.barcode, c.shelf_no, c.store_code,
             c.last_changed_at
        FROM public.petstore_skus s
        LEFT JOIN public.petstore_product_status_current c
               ON c.product_code = s.product_code
       WHERE ($1::text IS NULL OR s.product_code = $1)
         AND ($2::text IS NULL OR s.product_name ILIKE '%' || $2 || '%')
         AND ($3::text IS NULL OR s.category = $3)
         ${viewClause}
    ), total_count AS (SELECT COUNT(*)::int AS total FROM filtered),
    page_rows AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY month_sale DESC NULLS LAST, product_code ASC) AS __rn
        FROM filtered ORDER BY month_sale DESC NULLS LAST, product_code ASC LIMIT $4 OFFSET $5
    )
    SELECT COALESCE(
             jsonb_agg(to_jsonb(page_rows) - '__rn' ORDER BY page_rows.__rn)
               FILTER (WHERE page_rows.product_code IS NOT NULL),
             '[]'::jsonb) AS rows,
           total_count.total
      FROM total_count LEFT JOIN page_rows ON true GROUP BY total_count.total`;
  const r = await getPool().query(sql, params);
  const f = r.rows[0] || { rows: [], total: 0 };
  return { rows: f.rows, total: f.total, page, pageSize };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (!requireAuth(req, res)) return;
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });
    return json(res, 200, await listRows(req));
  } catch (e) { return json(res, 500, { ok: false, error: e.message || "server_error" }); }
}
