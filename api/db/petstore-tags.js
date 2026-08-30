
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function cleanText(value, max = 120) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}

function cleanBool(value) {
  const s = String(value ?? "").trim().toLowerCase();
  if (s === "true") return true;
  if (s === "false") return false;
  return null;
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
  const scope = cleanText(req.query?.scope, 80);
  const isActive = cleanBool(req.query?.is_active);
  const tagName = cleanText(req.query?.tag_name, 120);
  const source = cleanText(req.query?.source, 80);
  const params = [scope, isActive, tagName, source, pageSize, offset];
  const sql = `
    WITH filtered AS (
      SELECT tag_code, tag_name, scope, tag_type, color, sort_no, is_active,
             source, created_by, created_at
        FROM public.petstore_tags
       WHERE ($1::text IS NULL OR scope = $1)
         AND ($2::boolean IS NULL OR is_active = $2)
         AND ($3::text IS NULL OR tag_name ILIKE '%' || $3 || '%')
         AND ($4::text IS NULL OR source = $4)
    ), total_count AS (
      SELECT COUNT(*)::int AS total FROM filtered
    ), page_rows AS (
      SELECT tag_code, tag_name, scope, tag_type, color, sort_no, is_active,
             source, created_by, created_at
        FROM filtered
       ORDER BY sort_no ASC, tag_code ASC
       LIMIT $5 OFFSET $6
    )
    SELECT COALESCE(
             jsonb_agg(to_jsonb(page_rows)) FILTER (WHERE page_rows.tag_code IS NOT NULL),
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
