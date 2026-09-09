import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

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
  const keyword = cleanText(req.query?.keyword, 120);
  const params = [storeCode, keyword, pageSize, offset];
  const sql = `
    WITH filtered AS (
      SELECT *
        FROM petstore_offline_stock_snapshot
       WHERE ($1::text IS NULL OR store_code = $1)
         AND (
           $2::text IS NULL
           OR product_code ILIKE '%' || $2 || '%'
           OR upc_code ILIKE '%' || $2 || '%'
         )
    ), latest AS (
      SELECT DISTINCT ON (product_code)
             product_code, upc_code, spec, category_name, second_category_name,
             stock_num, out_price, store_code, store_name,   /* 0909 删 in_price,cost_price:红线,成本字段永不出库。页面本就不显示(dataMaps不映射),但接口JSON在返回,开发者工具可见 */
             captured_at
        FROM filtered
       ORDER BY product_code, capture_date DESC NULLS LAST, captured_at DESC NULLS LAST
    ), total_count AS (
      SELECT COUNT(*)::int AS total FROM latest
    ), page_rows AS (
      SELECT product_code, upc_code, spec, category_name, second_category_name,
             stock_num, out_price, store_code, store_name,   /* 0909 删 in_price,cost_price:红线,成本字段永不出库。页面本就不显示(dataMaps不映射),但接口JSON在返回,开发者工具可见 */
             captured_at
        FROM latest
       ORDER BY product_code
       LIMIT $3 OFFSET $4
    )
    SELECT COALESCE(
             jsonb_agg(to_jsonb(page_rows)) FILTER (WHERE page_rows.product_code IS NOT NULL),
             '[]'::jsonb
           ) AS rows,
           total_count.total
      FROM total_count
      LEFT JOIN page_rows ON true
     GROUP BY total_count.total`;
  const result = await getPool().query(sql, params);
  const first = result.rows[0] || { rows: [], total: 0 };
  return {
    rows: first.rows,
    total: first.total,
    page,
    pageSize,
  };
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
