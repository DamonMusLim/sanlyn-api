import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// Sensitive fields available in source view but not returned here: cost_price, supplier.
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

function trueFlag(value) {
  return String(value ?? "").trim().toLowerCase() === "true";
}

function json(res, status, data) {
  return res.status(status).json(data);
}

async function listRows(req) {
  const { page, pageSize, offset } = paging(req.query || {});
  const shelfCode = cleanText(req.query?.shelf_code, 120);
  const missingOnly = trueFlag(req.query?.missing_only);
  const params = [shelfCode, missingOnly, pageSize, offset];
  const sql = `
    WITH filtered AS (
      SELECT shelf_code, product_code, product_name, spec_text, cur_stock,
             shelf_missing
        FROM public.petstore_ops_row
       WHERE ($1::text IS NULL OR shelf_code = $1)
         AND ($2::boolean IS NOT TRUE OR shelf_missing IS TRUE)
    ), total_count AS (
      SELECT COUNT(*)::int AS total FROM filtered
    ), page_rows AS (
      SELECT shelf_code, product_code, product_name, spec_text, cur_stock,
             shelf_missing
        FROM filtered
       ORDER BY shelf_missing DESC NULLS LAST, shelf_code NULLS LAST, product_code
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
