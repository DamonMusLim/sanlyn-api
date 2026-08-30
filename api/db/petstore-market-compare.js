import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// Sensitive fields in related product sources, not selected here: cost_price, gross_margin_pct, gross_profit_90, supplier.
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
  const productCode = cleanText(req.query?.product_code, 80);
  const source = cleanText(req.query?.source, 80);
  const params = [productCode, source, pageSize, offset];
  const sql = `
    WITH filtered AS (
      SELECT product_code, source, store_name, matched_title, spec_text, price,
             orig_price, unit_price, monthly_sales, captured_at, match_conf
        FROM public.petstore_market_quotes
       WHERE is_comparable IS TRUE
         AND ($1::text IS NULL OR product_code = $1)
         AND ($2::text IS NULL OR source = $2)
    ), total_count AS (
      SELECT COUNT(*)::int AS total FROM filtered
    ), page_rows AS (
      SELECT product_code, source, store_name, matched_title, spec_text, price,
             orig_price, unit_price, monthly_sales, captured_at, match_conf
        FROM filtered
       ORDER BY captured_at DESC NULLS LAST, product_code, source
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
