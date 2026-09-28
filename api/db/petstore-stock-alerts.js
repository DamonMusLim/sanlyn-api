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

// 0928:原来读 petstore_offline_stock_snapshot 的「预警数量」—— 果冻橙全店都没设(alarm_num 全 0)、快照还停在 08-28,
// 页面恒空。改成实时口径:卖得动(近30天≥1件)但库存 ≤ 约一周的量(CEIL(月销/4)),库存用 petstore_skus(15分钟同步)。
// alarm_num 字段保留给 jdc 页面,值 = 这个「一周的量」门槛。店员 App(petstore-stock-report action=alerts)也调这里,别另写。
export async function listRows(req) {
  const { page, pageSize, offset } = paging(req.query || {});
  const params = [pageSize, offset];
  const sql = `
    WITH alerted AS (
      SELECT r.product_code, r.product_name, r.barcode AS upc_code, r.spec_text AS spec, r.category AS category_name,
             COALESCE(k.stock_num, r.cur_stock, 0) AS stock_num,
             CEIL(COALESCE(k.month_sale, 0) / 4.0)::int AS alarm_num,
             'week_of_sales' AS alarm_type, COALESCE(k.month_sale, 0) AS month_sale,
             r.shelf_code, r.pic_url, '63350001' AS store_code, k.synced_at AS captured_at
        FROM public.petstore_ops_row r
        JOIN public.petstore_skus k ON k.product_code = r.product_code
       WHERE COALESCE(k.month_sale, 0) >= 1
         AND COALESCE(k.stock_num, r.cur_stock, 0) <= CEIL(COALESCE(k.month_sale, 0) / 4.0)
    ), total_count AS (
      SELECT COUNT(*)::int AS total FROM alerted
    ), page_rows AS (
      SELECT * FROM alerted
       ORDER BY stock_num ASC NULLS LAST, month_sale DESC, product_code
       LIMIT $1 OFFSET $2
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
