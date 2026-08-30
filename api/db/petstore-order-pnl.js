import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 订单盈亏(24天) —— 喂「外卖利润」「营业占比分析」。\n// ⚠️ margin 是毛利总额(经营指标),不是单品成本;loss_* 是亏本行数。
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
  const params = [cleanText(req.query?.stat_date, 120), pageSize, offset];
  const sql = `
    WITH filtered AS (
      SELECT stat_date, orders, revenue, margin, loss_lines, loss_orders,\n             nocost_lines, synced_at
        FROM public.petstore_order_pnl
       WHERE ($1::text IS NULL OR stat_date::text = $1)
    ), total_count AS (SELECT COUNT(*)::int AS total FROM filtered),
    page_rows AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY stat_date DESC NULLS LAST) AS __rn
        FROM filtered ORDER BY stat_date DESC NULLS LAST LIMIT $2 OFFSET $3
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(page_rows) - '__rn' ORDER BY page_rows.__rn)
             FILTER (WHERE page_rows.stat_date IS NOT NULL), '[]'::jsonb) AS rows,
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
