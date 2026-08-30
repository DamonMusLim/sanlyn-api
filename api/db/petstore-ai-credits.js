import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// AI 次数流水 —— 喂「AI充值中心」。照果冻橙 getResidualDegree/rechargeAmount。
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
    cleanText(req.query?.biz_type, 40),
    cleanText(req.query?.task_no, 120),
    cleanText(req.query?.store_code, 80),
    cleanText(req.query?.remark, 120),
    pageSize, offset,
  ];
  const sql = `
    WITH filtered AS (
      SELECT id, store_code, biz_type, change_num, balance_after,
             amount_yuan, task_no, remark, created_at
        FROM public.petstore_ai_credits
       WHERE ($1::text IS NULL OR biz_type = $1)
         AND ($2::text IS NULL OR task_no = $2)
         AND ($3::text IS NULL OR store_code = $3)
         AND ($4::text IS NULL OR remark ILIKE '%' || $4 || '%')
    ), total_count AS (SELECT COUNT(*)::int AS total FROM filtered),
    page_rows AS (
      SELECT * FROM filtered ORDER BY created_at DESC NULLS LAST, id DESC LIMIT $5 OFFSET $6
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(page_rows)) FILTER (WHERE page_rows.id IS NOT NULL), '[]'::jsonb) AS rows,
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
