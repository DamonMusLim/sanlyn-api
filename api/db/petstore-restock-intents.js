import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 补货审核 —— Damon 0831:「智能补货和建议补货要给我审核」。
// 🩸 记忆教训:定价拍板卡曾经「点了不落地」(damon_verdict 全表0条)。
//    这张表的 CHECK 让"静默丢决策"在数据库层面不可能:
//    非 proposed 必须有 decided_by/at · 批准必须给量 · 驳回必须写原因
//    · 只有批准过的能执行 · 执行成功必须有单号+回读结论。
// ⛔ 只读接口。审核动作走 petstore-restock-decide(写接口,单独文件)。
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
    cleanText(req.query?.status, 40),
    cleanText(req.query?.batch_no, 60),
    cleanText(req.query?.store_code, 80),
    pageSize, offset,
  ];
  const sql = `
    WITH filtered AS (
      SELECT id, batch_no, store_code, product_code, product_name, spec,
             cur_stock, daily_avg_30, days_of_supply, qty_30, oos_days_30,
             suggest_qty, verdict_reason, source, status,
             decided_by, decided_at, decided_qty, decided_note,
             exec_status, exec_at, exec_order_no, exec_error, readback_ok, created_at,
             -- 🔴 库存为负是上游数据问题(果冻橙同步来的),标出来别让人当真
             (cur_stock < 0) AS stock_is_negative
        FROM public.petstore_restock_intents
       WHERE ($1::text IS NULL OR status = $1)
         AND ($2::text IS NULL OR batch_no = $2)
         AND ($3::text IS NULL OR store_code = $3)
    ), total_count AS (SELECT COUNT(*)::int AS total FROM filtered),
    page_rows AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY days_of_supply ASC NULLS FIRST, daily_avg_30 DESC NULLS LAST, id ASC) AS __rn
        FROM filtered
       ORDER BY days_of_supply ASC NULLS FIRST, daily_avg_30 DESC NULLS LAST, id ASC
       LIMIT $4 OFFSET $5
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(page_rows) - '__rn' ORDER BY page_rows.__rn)
             FILTER (WHERE page_rows.id IS NOT NULL), '[]'::jsonb) AS rows,
           total_count.total FROM total_count LEFT JOIN page_rows ON true GROUP BY total_count.total`;
  const r = await getPool().query(sql, params);
  const f = r.rows[0] || { rows: [], total: 0 };
  return { rows: f.rows, total: f.total, page, pageSize };
}

// 汇总:每个状态各多少条、多少量,给审核页顶部用
async function summary() {
  const r = await getPool().query(`
    SELECT status,
           COUNT(*)::int AS cnt,
           COALESCE(SUM(suggest_qty),0)::numeric AS suggest_total,
           COALESCE(SUM(decided_qty),0)::numeric AS decided_total,
           COUNT(*) FILTER (WHERE cur_stock < 0)::int AS negative_stock
      FROM public.petstore_restock_intents
     GROUP BY status ORDER BY 2 DESC`);
  return { rows: r.rows, total: r.rows.length };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (!requireAuth(req, res)) return;
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });
    const scope = String(req.query?.scope ?? "").trim();
    return json(res, 200, scope === "summary" ? await summary() : await listRows(req));
  } catch (e) { return json(res, 500, { ok: false, error: e.message || "server_error" }); }
}
