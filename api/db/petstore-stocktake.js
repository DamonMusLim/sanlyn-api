import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 盘点单 —— 喂「盘点」页,以及报盈(diff>0)/报损(diff<0)两页。
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const DIFF_SQL = { profit: "diff > 0", loss: "diff < 0", zero: "diff = 0" };

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
function json(res, status, data) { return res.status(status).json(data); }

async function listRows(req) {
  const { page, pageSize, offset } = paging(req.query || {});
  const storeCode = cleanText(req.query?.store_code, 80);
  const status = cleanText(req.query?.status, 40);
  const productCode = cleanText(req.query?.product_code, 120);
  const diffKey = cleanText(req.query?.diff, 20);
  const diffClause = (diffKey && DIFF_SQL[diffKey]) ? `AND (${DIFF_SQL[diffKey]})` : "";

  const params = [storeCode, status, productCode, pageSize, offset];
  const sql = `
    WITH filtered AS (
      SELECT ymd, store_code, product_code, product_name,
             book_qty, count_qty, diff, priority, note, reason, status,
             created_at, counted_at, reviewed_at, applied_at, profitloss_result
        FROM public.petstore_stocktake
       WHERE ($1::text IS NULL OR store_code = $1)
         AND ($2::text IS NULL OR status = $2)
         AND ($3::text IS NULL OR product_code = $3)
         ${diffClause}
    ), total_count AS (
      SELECT COUNT(*)::int AS total FROM filtered
    ), page_rows AS (
      SELECT * FROM filtered
       ORDER BY ymd DESC NULLS LAST, product_code ASC
       LIMIT $4 OFFSET $5
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
