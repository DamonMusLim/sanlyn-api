import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

function json(res, s, d) { return res.status(s).json(d); }
function clean(v, m = 80) { const s = String(v ?? "").trim(); return s ? s.slice(0, m) : null; }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

const ISSUES = new Set(["expiring", "no_shelf", "no_date", "price_gap"]);
const ORDER = "severity DESC NULLS LAST, days_to_expire ASC NULLS LAST, product_code ASC";
const NO_SHELF = "(shelf_list IS NULL OR btrim(shelf_list) IN ('', '[]'))";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (!requireAuth(req, res)) return;
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });

    const q = req.query || {};
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(300, Math.max(1, Number(q.pageSize) || 20));
    const issue = ISSUES.has(String(q.issue || "")) ? String(q.issue) : null;
    const keyword = clean(q.q, 80);
    const category = clean(q.category, 80);
    const daysLte = num(q.days_lte);
    const summaryOnly = String(q.scope || "") === "summary";

    const sql = `
      WITH base AS (
        SELECT h.product_code, h.product_name, h.category, h.shelf_list,
               h.out_price, h.ext_price, h.ext_channel, h.stock_num, h.month_sale,
               h.expire_date_batch, h.days_to_expire, h.main_problem, h.problems,
               h.severity, h.is_expiring, h.no_date, h.price_gap,
               ${NO_SHELF} AS no_shelf,
               CASE
                 WHEN ${NO_SHELF} THEN '无货架号'
                 ELSE COALESCE((
                   SELECT string_agg(x.v, ' / ' ORDER BY x.ord)
                     FROM jsonb_array_elements_text(h.shelf_list::jsonb) WITH ORDINALITY AS x(v, ord)
                    WHERE btrim(x.v) <> ''
                 ), '无货架号')
               END AS shelf_text
          FROM public.petstore_health h
      ), searched AS (
        SELECT *
          FROM base
         WHERE ($1::text IS NULL OR product_name ILIKE '%' || $1 || '%'
                OR product_code ILIKE '%' || $1 || '%'
                OR category ILIKE '%' || $1 || '%')
           AND ($2::text IS NULL OR category = $2)
           AND ($3::numeric IS NULL OR days_to_expire <= $3)
      ), counts AS (
        SELECT COUNT(*) FILTER (WHERE COALESCE(is_expiring, false) OR days_to_expire <= 60)::int AS expiring,
               COUNT(*) FILTER (WHERE no_shelf)::int AS no_shelf,
               COUNT(*) FILTER (WHERE COALESCE(no_date, false))::int AS no_date,
               COUNT(*) FILTER (WHERE COALESCE(price_gap, false))::int AS price_gap
          FROM searched
      ), filtered AS (
        SELECT *
          FROM searched
         WHERE ($4::text IS NULL
                OR ($4 = 'expiring' AND (COALESCE(is_expiring, false) OR days_to_expire <= 60))
                OR ($4 = 'no_shelf' AND no_shelf)
                OR ($4 = 'no_date' AND COALESCE(no_date, false))
                OR ($4 = 'price_gap' AND COALESCE(price_gap, false)))
      ), total_count AS (
        SELECT COUNT(*)::int AS total FROM filtered
      ), page_rows AS (
        SELECT *, ROW_NUMBER() OVER (ORDER BY ${ORDER}) AS __rn
          FROM filtered
         ORDER BY ${ORDER}
         LIMIT $5 OFFSET $6
      )
      SELECT COALESCE(jsonb_agg(to_jsonb(page_rows) - '__rn' ORDER BY page_rows.__rn)
               FILTER (WHERE page_rows.product_code IS NOT NULL), '[]'::jsonb) AS rows,
             total_count.total,
             jsonb_build_object(
               'expiring', counts.expiring,
               'no_shelf', counts.no_shelf,
               'no_date', counts.no_date,
               'price_gap', counts.price_gap
             ) AS counts
        FROM total_count
        CROSS JOIN counts
        LEFT JOIN page_rows ON true
       GROUP BY total_count.total, counts.expiring, counts.no_shelf, counts.no_date, counts.price_gap`;

    const r = await getPool().query(sql, [
      keyword, category, daysLte, issue, summaryOnly ? 1 : pageSize, summaryOnly ? 0 : (page - 1) * pageSize,
    ]);
    const f = r.rows[0] || { rows: [], total: 0, counts: { expiring: 0, no_shelf: 0, no_date: 0, price_gap: 0 } };

    if (summaryOnly) {
      return json(res, 200, { rows: [f.counts], total: 1, counts: f.counts, page: 1, pageSize: 1 });
    }

    return json(res, 200, { rows: f.rows, total: f.total, counts: f.counts, page, pageSize });
  } catch (e) {
    return json(res, 500, { error: e.message || "server_error" });
  }
}
