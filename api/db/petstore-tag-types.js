
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
  const scope = cleanText(req.query?.scope, 80);
  const typeName = cleanText(req.query?.type_name, 120);
  const params = [scope, typeName, pageSize, offset];
  const sql = `
    WITH filtered AS (
      SELECT type_code, type_name, scope, is_system, hint, sort_no, src_id, created_at
        FROM public.petstore_tag_types
       WHERE ($1::text IS NULL OR scope = $1)
         AND ($2::text IS NULL OR type_name ILIKE '%' || $2 || '%')
    ), total_count AS (
      SELECT COUNT(*)::int AS total FROM filtered
    ), page_types AS (
      SELECT type_code, type_name, scope, is_system, hint, sort_no, src_id, created_at
        FROM filtered
       ORDER BY sort_no ASC, type_code ASC
       LIMIT $3 OFFSET $4
    ), page_rows AS (
      SELECT t.type_code, t.type_name, t.scope, t.is_system, t.hint,
             t.sort_no, t.src_id, t.created_at,
             COALESCE(
               jsonb_agg(
                 jsonb_build_object(
                   'tag_code', g.tag_code,
                   'tag_name', g.tag_name,
                   'color', g.color,
                   'sort_no', g.sort_no
                 )
                 ORDER BY g.sort_no ASC, g.tag_code ASC
               ) FILTER (WHERE g.tag_code IS NOT NULL),
               '[]'::jsonb
             ) AS tags
        FROM page_types t
        LEFT JOIN public.petstore_tags g ON g.type_code = t.type_code
       GROUP BY t.type_code, t.type_name, t.scope, t.is_system, t.hint,
                t.sort_no, t.src_id, t.created_at
    )
    SELECT COALESCE(
             jsonb_agg(to_jsonb(page_rows) ORDER BY page_rows.sort_no ASC, page_rows.type_code ASC)
               FILTER (WHERE page_rows.type_code IS NOT NULL),
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
