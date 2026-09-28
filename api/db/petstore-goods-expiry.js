import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// Sensitive fields available in source view but not returned here: cost_price, in_price, supplier.
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function nonNegativeInt(value) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
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
  const maxDays = nonNegativeInt(req.query?.max_days);
  const params = [maxDays, pageSize, offset];
  const sql = `
    WITH filtered AS (
      -- 0928:库存统一取 petstore_skus.stock_num(每15分钟同步果冻橙,跟店员App/收银机同一个数);cur_stock 保留原值不删。
      -- 效期快照每天追加一行,product_code 不唯一 → LATERAL 只取最新一条(原来普通 JOIN:135 品出 912 行)。
      SELECT r.product_code, r.product_name, r.spec_text, r.cur_stock, k.stock_num, r.days_left,
             r.expiry_flag, r.shelf_code, e.out_price
        FROM public.petstore_ops_row r
        LEFT JOIN public.petstore_skus k ON k.product_code = r.product_code
        LEFT JOIN LATERAL (SELECT x.out_price FROM public.petstore_offline_expiry_snapshot x
                            WHERE x.product_code = r.product_code
                            ORDER BY x.captured_at DESC, x.record_id DESC LIMIT 1) e ON true
       WHERE r.days_left IS NOT NULL
         AND ($1::int IS NULL OR r.days_left <= $1::int)
    ), total_count AS (
      SELECT COUNT(*)::int AS total FROM filtered
    ), page_rows AS (
      SELECT product_code, product_name, spec_text, cur_stock, stock_num, days_left,
             expiry_flag, shelf_code, out_price
        FROM filtered
       ORDER BY days_left ASC, product_code
       LIMIT $2 OFFSET $3
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
