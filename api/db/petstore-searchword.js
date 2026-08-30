import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 美团搜索词排名(148条) —— 喂「影响流量商品」「营业占比分析」的流量侧。
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
  const params = [cleanText(req.query?.rank_type, 120), cleanText(req.query?.search_word, 120), pageSize, offset];
  const sql = `
    WITH filtered AS (
      SELECT capture_date, wm_poi_id, rank_type, search_word, rank_num,
             exposure_cnt, click_cnt, order_cnt, avg_rank, min_rank, max_rank,
             ctr_uv, cvr_uv, cxr_uv, data_date
        FROM public.petstore_mt_searchword_ranking
       WHERE ($1::text IS NULL OR rank_type = $1)
         AND ($2::text IS NULL OR search_word ILIKE '%' || $2 || '%')
    ), total_count AS (SELECT COUNT(*)::int AS total FROM filtered),
    page_rows AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY rank_num ASC NULLS LAST, exposure_cnt DESC) AS __rn
        FROM filtered ORDER BY rank_num ASC NULLS LAST, exposure_cnt DESC LIMIT $3 OFFSET $4
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(page_rows) - '__rn' ORDER BY page_rows.__rn)
             FILTER (WHERE page_rows.search_word IS NOT NULL), '[]'::jsonb) AS rows,
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
