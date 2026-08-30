import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 价格历史(55951行) —— 喂 调价监控/价格变动/商品销售分析。
// ⛔ price 是【售价】不是进价;源表没有成本列,天然安全,但仍逐列取。
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
  const params = [
    cleanText(req.query?.product_code, 120),
    cleanText(req.query?.channel, 40),
    cleanText(req.query?.price_type, 40),
    pageSize, offset,
  ];
  const sql = `
    WITH filtered AS (
      SELECT h.product_code, h.barcode, h.channel, h.price, h.price_type,
             h.effective_at, h.captured_at, h.is_effective, h.exec_status, h.result,
             s.product_name, s.spec, s.category
        FROM public.petstore_price_history h
        LEFT JOIN public.petstore_skus s ON s.product_code = h.product_code
       WHERE ($1::text IS NULL OR h.product_code = $1)
         AND ($2::text IS NULL OR h.channel = $2)
         AND ($3::text IS NULL OR h.price_type = $3)
    ), total_count AS (SELECT COUNT(*)::int AS total FROM filtered),
    page_rows AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY effective_at DESC NULLS LAST, product_code ASC) AS __rn
        FROM filtered ORDER BY effective_at DESC NULLS LAST, product_code ASC LIMIT $4 OFFSET $5
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(page_rows) - '__rn' ORDER BY page_rows.__rn)
             FILTER (WHERE page_rows.product_code IS NOT NULL), '[]'::jsonb) AS rows,
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
