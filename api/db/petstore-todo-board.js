import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 每日待办看板 —— 学它大夫「今日待办」那个格子面板的做法:一格一类,大数字 + 名称。
// scope=board 出各类型的汇总数字;scope=list 出某一类的明细。
// ⛔ 源表 petstore_daily_todo 有 supplier / out_price;supplier 不返回(商品类页面),
//    out_price 是售价不是成本,允许。
const DEFAULT_PAGE = 1, DEFAULT_PAGE_SIZE = 50, MAX_PAGE_SIZE = 200;
function cleanText(v, m = 120) { const s = String(v ?? "").trim(); return s ? s.slice(0, m) : null; }
function positiveInt(v, f) { const n = Number.parseInt(v ?? "", 10); return Number.isFinite(n) && n > 0 ? n : f; }
function paging(q) {
  const page = positiveInt(q?.page, DEFAULT_PAGE);
  const pageSize = Math.min(positiveInt(q?.pageSize, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  return { page, pageSize, offset: (page - 1) * pageSize };
}
function json(res, s, d) { return res.status(s).json(d); }

async function board(req) {
  // 只看最新快照那一天,跟「今日待办」的语义一致
  const sql = `
    WITH latest AS (SELECT MAX(snapshot_date) AS d FROM public.petstore_daily_todo)
    SELECT todo_type,
           COUNT(*)::int                                        AS total,
           COUNT(*) FILTER (WHERE done_at IS NULL)::int          AS pending,
           COUNT(*) FILTER (WHERE done_at IS NOT NULL)::int      AS done,
           MAX(snapshot_date)                                    AS snapshot_date
      FROM public.petstore_daily_todo, latest
     WHERE snapshot_date = latest.d
     GROUP BY todo_type
     ORDER BY COUNT(*) FILTER (WHERE done_at IS NULL) DESC, todo_type ASC`;
  const r = await getPool().query(sql);
  const rows = r.rows || [];
  const sum = rows.reduce((a, x) => a + Number(x.pending || 0), 0);
  return { rows, total: rows.length, pending_total: sum,
           snapshot_date: rows[0]?.snapshot_date || null };
}

async function listRows(req) {
  const { page, pageSize, offset } = paging(req.query || {});
  const params = [
    cleanText(req.query?.todo_type, 40),
    cleanText(req.query?.product_code, 120),
    pageSize, offset,
  ];
  const sql = `
    WITH latest AS (SELECT MAX(snapshot_date) AS d FROM public.petstore_daily_todo),
    filtered AS (
      SELECT t.id, t.snapshot_date, t.todo_type, t.shelf, t.product_name, t.spec,
             t.warn_status, t.production_date, t.expire_date, t.stock, t.out_price,
             t.month_sale, t.product_code, t.barcode, t.category,
             t.expiry_grade, t.days_left_text, t.done_at, t.done_by, t.created_at
        FROM public.petstore_daily_todo t, latest
       WHERE t.snapshot_date = latest.d
         AND ($1::text IS NULL OR t.todo_type = $1)
         AND ($2::text IS NULL OR t.product_code = $2)
    ), total_count AS (SELECT COUNT(*)::int AS total FROM filtered),
    page_rows AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY done_at NULLS FIRST, id DESC) AS __rn
        FROM filtered ORDER BY done_at NULLS FIRST, id DESC LIMIT $3 OFFSET $4
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
    const scope = String(req.query?.scope ?? "").trim();
    return json(res, 200, scope === "board" ? await board(req) : await listRows(req));
  } catch (e) { return json(res, 500, { ok: false, error: e.message || "server_error" }); }
}
