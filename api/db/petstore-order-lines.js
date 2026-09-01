import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 订单商品明细 / 收银订单 —— public.petstore_stock_ledger 销售流水。
// 只读接口；不选、不返、不 join 任何价格/金额/成本字段。
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function json(res, status, data) {
  return res.status(status).json(data);
}

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

function channel(value) {
  const s = cleanText(value, 8);
  return s === "0" || s === "1" ? Number(s) : null;
}

function dateText(value) {
  const s = cleanText(value, 20);
  return /^\d{4}-\d{2}-\d{2}$/.test(s || "") ? s : null;
}

function baseParams(query) {
  return [
    cleanText(query?.store_code, 80),
    cleanText(query?.q, 120),
    cleanText(query?.category, 120),
    channel(query?.channel),
    dateText(query?.date_from),
    dateText(query?.date_to),
  ];
}

async function listLines(req) {
  const { page, pageSize, offset } = paging(req.query || {});
  const params = [...baseParams(req.query || {}), pageSize, offset];
  const sql = `
    WITH filtered AS (
      SELECT order_no, category_name, product_name, product_code, upc_code,
             product_code || ' / ' || COALESCE(NULLIF(upc_code, ''), '-') AS code_upc,
             ABS(delta) AS qty, change_time, order_channel
        FROM public.petstore_stock_ledger
       WHERE order_type = 'XS'
         AND order_no IS NOT NULL
         AND order_no <> ''
         AND ($1::text IS NULL OR store_code = $1)
         AND (
           $2::text IS NULL
           OR product_name ILIKE '%' || $2 || '%'
           OR product_code ILIKE '%' || $2 || '%'
           OR upc_code ILIKE '%' || $2 || '%'
           OR order_no ILIKE '%' || $2 || '%'
         )
         AND ($3::text IS NULL OR category_name = $3)
         AND ($4::int IS NULL OR order_channel = $4)
         AND ($5::date IS NULL OR change_time >= $5::date)
         AND ($6::date IS NULL OR change_time < ($6::date + INTERVAL '1 day'))
    ), total_count AS (
      SELECT COUNT(*)::int AS total FROM filtered
    ), page_rows AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY change_time DESC NULLS LAST, order_no ASC) AS __rn
        FROM filtered
       ORDER BY change_time DESC NULLS LAST, order_no ASC
       LIMIT $7 OFFSET $8
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(page_rows) - '__rn' ORDER BY page_rows.__rn)
             FILTER (WHERE page_rows.order_no IS NOT NULL), '[]'::jsonb) AS rows,
           total_count.total
      FROM total_count
      LEFT JOIN page_rows ON true
     GROUP BY total_count.total`;

  const result = await getPool().query(sql, params);
  const first = result.rows[0] || { rows: [], total: 0 };
  return { rows: first.rows, total: first.total, page, pageSize };
}

async function listOrders(req) {
  const { page, pageSize, offset } = paging(req.query || {});
  const params = [...baseParams(req.query || {}), pageSize, offset];
  const sql = `
    WITH filtered AS (
      SELECT order_no, store_code, order_channel, change_time, delta,
             product_name, product_code, upc_code, category_name
        FROM public.petstore_stock_ledger
       WHERE order_type = 'XS'
         AND order_no IS NOT NULL
         AND order_no <> ''
         AND ($1::text IS NULL OR store_code = $1)
         AND (
           $2::text IS NULL
           OR product_name ILIKE '%' || $2 || '%'
           OR product_code ILIKE '%' || $2 || '%'
           OR upc_code ILIKE '%' || $2 || '%'
           OR order_no ILIKE '%' || $2 || '%'
         )
         AND ($3::text IS NULL OR category_name = $3)
         AND ($4::int IS NULL OR order_channel = $4)
         AND ($5::date IS NULL OR change_time >= $5::date)
         AND ($6::date IS NULL OR change_time < ($6::date + INTERVAL '1 day'))
    ), grouped AS (
      SELECT order_no, MIN(store_code) AS store_code, MIN(change_time) AS sold_at,
             MIN(order_channel) AS order_channel, COUNT(*)::int AS line_count,
             SUM(ABS(delta)) AS qty_total
        FROM filtered
       GROUP BY order_no
    ), total_count AS (
      SELECT COUNT(*)::int AS total FROM grouped
    ), page_rows AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY sold_at DESC NULLS LAST, order_no ASC) AS __rn
        FROM grouped
       ORDER BY sold_at DESC NULLS LAST, order_no ASC
       LIMIT $7 OFFSET $8
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(page_rows) - '__rn' ORDER BY page_rows.__rn)
             FILTER (WHERE page_rows.order_no IS NOT NULL), '[]'::jsonb) AS rows,
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
    const scope = cleanText(req.query?.scope, 20);
    return json(res, 200, scope === "orders" ? await listOrders(req) : await listLines(req));
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message || "server_error" });
  }
}
