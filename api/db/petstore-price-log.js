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
  const channel = cleanText(req.query?.channel, 80);
  const status = cleanText(req.query?.status, 80);
  const from = cleanText(req.query?.from, 40);
  const to = cleanText(req.query?.to, 40);
  const params = [productCode, channel, status, from, to, pageSize, offset];
  const sql = `
    WITH filtered AS (
      SELECT i.product_code, i.product_name, i.channel, i.old_price, i.target_price,
             i.reason, i.status, i.author, i.created_at, i.applied_at
        FROM public.petstore_price_intents i
        LEFT JOIN LATERAL (
          SELECT h.id
            FROM public.petstore_price_history h
           WHERE h.product_code = i.product_code
             AND h.channel = i.channel
           ORDER BY h.effective_at DESC NULLS LAST, h.captured_at DESC NULLS LAST, h.id DESC
           LIMIT 1
        ) latest_history ON true
       WHERE ($1::text IS NULL OR i.product_code = $1)
         AND ($2::text IS NULL OR i.channel = $2)
         AND ($3::text IS NULL OR i.status = $3)
         AND ($4::timestamptz IS NULL OR i.created_at >= $4::timestamptz)
         AND ($5::timestamptz IS NULL OR i.created_at <= $5::timestamptz)
    ), total_count AS (
      SELECT COUNT(*)::int AS total FROM filtered
    ), page_rows AS (
      SELECT product_code, product_name, channel, old_price, target_price,
             reason, status, author, created_at, applied_at
        FROM filtered
       ORDER BY created_at DESC NULLS LAST, product_code, channel
       LIMIT $6 OFFSET $7
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
