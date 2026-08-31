import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 门店要货的商品清单 —— 从果冻橙拉来的 2935 行采购配置。
//
// 🔴 cost_price(线下进价) / gross_margin_pct(毛利率) 只在库里,【不出接口】。
//    页面上那两列如实空着。
//
// 这一页在果冻橙是 2936 条,我们 2935(差 1,分页漂掉的,已记在案)。
function json(res, s, d) { return res.status(s).json(d); }
function clean(v, m = 80) { const s = String(v ?? "").trim(); return s ? s.slice(0, m) : null; }

const ORDER = Object.assign(Object.create(null), {
  days: "days_available ASC NULLS FIRST",     // 可销天数最短的在前 = 最急的
  stock: "stock_num ASC NULLS FIRST",
  sale: "month_sale DESC NULLS LAST",
  code: "product_code ASC",
});

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (!requireAuth(req, res)) return;
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });
    const q = req.query || {};
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(300, Math.max(1, Number(q.pageSize) || 20));
    const sortKey = clean(q.sort, 20);
    const orderBy = (sortKey && Object.hasOwn(ORDER, sortKey)) ? ORDER[sortKey] : ORDER.days;

    const sql = `
      WITH filtered AS (
        SELECT g.store_code, g.product_code, g.product_name, g.spec, g.upc_code,
               g.supplier_code, g.supplier_name, g.out_price,
               g.stock_num, g.in_transit_num, g.day_sale, g.week_sale, g.month_sale,
               g.days_available, g.min_order, g.order_multiple, g.purchase_unit,
               g.relation_ali, g.pulled_at,
               -- ⛔ cost_price / gross_margin_pct 故意不选
               -- 编码/条码/分类 那一列果冻橙是三行叠着显示的,这里拼一下
               g.product_code || ' / ' || COALESCE(g.upc_code, '-') AS code_upc,
               -- 起订量+倍数算出「实际该下多少」
               CASE WHEN g.min_order IS NULL THEN NULL
                    WHEN g.order_multiple IS NULL OR g.order_multiple <= 1 THEN g.min_order
                    ELSE CEIL(g.min_order / g.order_multiple) * g.order_multiple
               END AS orderable_min,
               -- 这个品果冻橙有没有给补货建议(和智能补货那页对上)
               (SELECT s.suggest_num FROM public.petstore_gdc_suggest s
                 WHERE s.product_code = g.product_code AND s.store_code = g.store_code) AS suggest_num
          FROM public.petstore_gdc_purchase_config g
         WHERE ($1::text IS NULL OR g.store_code = $1)
           AND ($2::text IS NULL OR g.product_name ILIKE '%' || $2 || '%'
                OR g.product_code = $2 OR g.upc_code = $2)
           AND ($3::text IS NULL OR g.supplier_code = $3)
           AND ($4::text IS NULL OR ($4 = 'zero' AND g.stock_num <= 0)
                                 OR ($4 = 'has'  AND g.stock_num > 0))
      ), total_count AS (SELECT COUNT(*)::int AS total FROM filtered),
      page_rows AS (
        SELECT *, ROW_NUMBER() OVER (ORDER BY ${orderBy}, product_code) AS __rn
          FROM filtered ORDER BY ${orderBy}, product_code
         LIMIT $5 OFFSET $6
      )
      SELECT COALESCE(jsonb_agg(to_jsonb(page_rows) - '__rn' ORDER BY page_rows.__rn)
               FILTER (WHERE page_rows.product_code IS NOT NULL), '[]'::jsonb) AS rows,
             total_count.total FROM total_count LEFT JOIN page_rows ON true GROUP BY total_count.total`;

    const r = await getPool().query(sql, [
      clean(q.store_code), clean(q.q, 60), clean(q.supplier_code, 40),
      clean(q.stock, 10), pageSize, (page - 1) * pageSize,
    ]);
    const f = r.rows[0] || { rows: [], total: 0 };
    return json(res, 200, { rows: f.rows, total: f.total, page, pageSize });
  } catch (e) { return json(res, 500, { error: e.message || "server_error" }); }
}
