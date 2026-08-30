import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// AI 任务(修图/电商图/合成图/生成卖点/打标) —— 照果冻橙 aiOptimizePicture 那套流程。
const DEFAULT_PAGE = 1, DEFAULT_PAGE_SIZE = 50, MAX_PAGE_SIZE = 200;
function cleanText(v, max = 120) { const s = String(v ?? "").trim(); return s ? s.slice(0, max) : null; }
function positiveInt(v, f) { const n = Number.parseInt(v ?? "", 10); return Number.isFinite(n) && n > 0 ? n : f; }
function paging(q) {
  const page = positiveInt(q?.page, DEFAULT_PAGE);
  const pageSize = Math.min(positiveInt(q?.pageSize, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  return { page, pageSize, offset: (page - 1) * pageSize };
}
function json(res, s, d) { return res.status(s).json(d); }

async function listRows(req) {
  const { page, pageSize, offset } = paging(req.query || {});
  const params = [
    cleanText(req.query?.task_type, 40),
    cleanText(req.query?.status, 40),
    cleanText(req.query?.store_code, 80),
    cleanText(req.query?.product_code, 120),
    pageSize, offset,
  ];
  const sql = `
    WITH filtered AS (
      SELECT task_no, task_type, store_code, product_code, status, queue_pos,
             cost_degree, refunded, src_url, result_url, applied_to_product,
             err_msg, created_by, created_at, started_at, finished_at
        FROM public.petstore_ai_tasks
       WHERE ($1::text IS NULL OR task_type = $1)
         AND ($2::text IS NULL OR status = $2)
         AND ($3::text IS NULL OR store_code = $3)
         AND ($4::text IS NULL OR product_code = $4)
    ), total_count AS (SELECT COUNT(*)::int AS total FROM filtered),
    page_rows AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY created_at DESC NULLS LAST, task_no DESC) AS __rn FROM filtered ORDER BY created_at DESC NULLS LAST, task_no DESC LIMIT $5 OFFSET $6
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(page_rows) - '__rn' ORDER BY page_rows.__rn) FILTER (WHERE page_rows.task_no IS NOT NULL), '[]'::jsonb) AS rows,
           total_count.total
      FROM total_count LEFT JOIN page_rows ON true GROUP BY total_count.total`;
  const r = await getPool().query(sql, params);
  const f = r.rows[0] || { rows: [], total: 0 };
  return { rows: f.rows, total: f.total, page, pageSize };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (!requireAuth(req, res)) return;
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });
    return json(res, 200, await listRows(req));
  } catch (e) { return json(res, 500, { ok: false, error: e.message || "server_error" }); }
}
