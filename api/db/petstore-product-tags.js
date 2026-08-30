
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
  const productCode = cleanText(req.query?.product_code, 120);
  const tagCode = cleanText(req.query?.tag_code, 120);
  const storeCode = cleanText(req.query?.store_code, 80);
  const source = cleanText(req.query?.source, 80);
  const params = [productCode, tagCode, storeCode, source, pageSize, offset];
  const sql = `
    WITH filtered AS (
      SELECT pt.product_code, pt.tag_code, t.tag_name AS tag_name, t.scope AS scope,
             pt.store_code, pt.confidence, pt.source, pt.task_no,
             pt.tagged_by, pt.tagged_at
        FROM public.petstore_product_tags pt
        LEFT JOIN public.petstore_tags t ON t.tag_code = pt.tag_code
       WHERE ($1::text IS NULL OR pt.product_code = $1)
         AND ($2::text IS NULL OR pt.tag_code = $2)
         AND ($3::text IS NULL OR pt.store_code = $3)
         AND ($4::text IS NULL OR pt.source = $4)
    ), total_count AS (
      SELECT COUNT(*)::int AS total FROM filtered
    ), page_rows AS (
      SELECT product_code, tag_code, tag_name, scope, store_code, confidence,
             source, task_no, tagged_by, tagged_at
        FROM filtered
       ORDER BY tagged_at DESC NULLS LAST
       LIMIT $5 OFFSET $6
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
