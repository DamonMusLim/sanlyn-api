import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 缺货时长 —— public.petstore_sku_sales_dna 最新快照。
// 只读接口；成本/利润相关字段不选、不返、不筛。
function json(res, s, d) { return res.status(s).json(d); }
function clean(v, m = 80) { const s = String(v ?? "").trim(); return s ? s.slice(0, m) : null; }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

const ORDER = "daily_avg_30 DESC NULLS LAST, oos_days_30 DESC NULLS LAST, product_code ASC";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (!requireAuth(req, res)) return;
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });
    const q = req.query || {};

    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(300, Math.max(1, Number(q.pageSize) || 20));

    const sql = `
      WITH latest AS (
        SELECT max(as_of) AS as_of FROM public.petstore_sku_sales_dna
      ), filtered AS (
        SELECT s.as_of, s.store_code, s.product_code, s.product_name,
               s.category_name, s.spec, s.qty_30, s.qty_90, s.sale_days_30,
               s.daily_avg_30, s.daily_avg_90, s.days_since_last_sale,
               s.oos_days_30, s.oos_days_90, s.cur_stock, s.days_of_supply,
               s.velocity_tier, s.restock_verdict, s.restock_qty,
               s.verdict_reason
          FROM public.petstore_sku_sales_dna s
          JOIN latest l ON l.as_of = s.as_of
         WHERE s.oos_days_30 > 0
           AND ($1::text IS NULL OR s.store_code = $1)
           AND ($2::text IS NULL OR s.product_name ILIKE '%' || $2 || '%'
                OR s.product_code ILIKE '%' || $2 || '%')
           AND ($3::text IS NULL OR s.category_name = $3)
           AND ($4::numeric IS NULL OR s.oos_days_30 >= $4)
           AND ($5::text IS NULL OR s.velocity_tier = $5)
      ), total_count AS (SELECT COUNT(*)::int AS total FROM filtered),
      page_rows AS (
        SELECT *, ROW_NUMBER() OVER (ORDER BY ${ORDER}) AS __rn
          FROM filtered
         ORDER BY ${ORDER}
         LIMIT $6 OFFSET $7
      )
      SELECT COALESCE(jsonb_agg(to_jsonb(page_rows) - '__rn' ORDER BY page_rows.__rn)
               FILTER (WHERE page_rows.product_code IS NOT NULL), '[]'::jsonb) AS rows,
             total_count.total
        FROM total_count LEFT JOIN page_rows ON true
       GROUP BY total_count.total`;

    const r = await getPool().query(sql, [
      clean(q.store_code, 40),
      clean(q.q, 80),
      clean(q.category, 80),
      num(q.oos_days_gte),
      clean(q.velocity_tier, 40),
      pageSize,
      (page - 1) * pageSize,
    ]);
    const f = r.rows[0] || { rows: [], total: 0 };
    return json(res, 200, { rows: f.rows, total: f.total, page, pageSize });
  } catch (e) { return json(res, 500, { error: e.message || "server_error" }); }
}
