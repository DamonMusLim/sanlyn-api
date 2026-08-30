import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 外卖平台每日经营(147条) —— 美团45天/饿了么67天/京东35天。\n// 数据源:mini caw_knowledge.db(美团/饿了么/京东采集链)。⛔ 无成本列。
const DEFAULT_PAGE = 1, DEFAULT_PAGE_SIZE = 50, MAX_PAGE_SIZE = 200;
function cleanText(v, m = 120) { const s = String(v ?? "").trim(); return s ? s.slice(0, m) : null; }
function positiveInt(v, f) { const n = Number.parseInt(v ?? "", 10); return Number.isFinite(n) && n > 0 ? n : f; }
function paging(q) {
  const page = positiveInt(q?.page, DEFAULT_PAGE);
  const pageSize = Math.min(positiveInt(q?.pageSize, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  return { page, pageSize, offset: (page - 1) * pageSize };
}
function json(res, s, d) { return res.status(s).json(d); }

async function listRows(req) {
  const { page, pageSize, offset } = paging(req.query || {});
  const params = [cleanText(req.query?.platform, 120), cleanText(req.query?.store_code, 120), cleanText(req.query?.stat_date, 120), pageSize, offset];
  const sql = `
    WITH filtered AS (
      SELECT id, stat_date, store_code, platform, turnover, orders,\n             comment_score, experience_score, new_buyers, synced_at
        FROM public.petstore_platform_daily
       WHERE ($1::text IS NULL OR platform::text = $1)
         AND ($2::text IS NULL OR store_code::text = $2)
         AND ($3::text IS NULL OR stat_date::text = $3)
    ), total_count AS (SELECT COUNT(*)::int AS total FROM filtered),
    page_rows AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY stat_date DESC NULLS LAST, platform ASC) AS __rn
        FROM filtered ORDER BY stat_date DESC NULLS LAST, platform ASC LIMIT $4 OFFSET $5
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(page_rows) - '__rn' ORDER BY page_rows.__rn)
             FILTER (WHERE page_rows.id IS NOT NULL), '[]'::jsonb) AS rows,
           total_count.total FROM total_count LEFT JOIN page_rows ON true GROUP BY total_count.total`;
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
