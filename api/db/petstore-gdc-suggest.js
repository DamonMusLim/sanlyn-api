import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 智能补货 —— 从果冻橙拉来的 2016 条补货建议。
//
// 🔴 成本红线:cost_price / gross_margin_pct 在库里,但【一律不出接口】。
//    页面上「线下进价」「毛利率」两列会如实显示「未接入」——不是没数据,是不给看。
//
// ⛔ 这一页【只读】。任何建议要变成订货单,必须走 petstore_restock_intents 的人工审核,
//    「智能补货和建议补货要给我审核」是 Damon 定的。
const ORDER = Object.assign(Object.create(null), {
  shortage: "shortage_day DESC NULLS LAST",     // 缺货天数最久的在前
  suggest:  "suggest_num DESC NULLS LAST",
  sale:     "month_sale DESC NULLS LAST",
  code:     "product_code ASC",
});

function json(res, s, d) { return res.status(s).json(d); }
function clean(v, m = 80) { const s = String(v ?? "").trim(); return s ? s.slice(0, m) : null; }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

async function list(q) {
  const page = Math.max(1, Number(q?.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(q?.pageSize) || 20));
  const sortKey = clean(q?.sort, 20);
  const orderBy = (sortKey && Object.hasOwn(ORDER, sortKey)) ? ORDER[sortKey] : ORDER.shortage;

  const sql = `
    WITH filtered AS (
      SELECT s.store_code, s.product_code, s.product_name, s.spec, s.upc_code,
             s.supplier_code, s.supplier_name, s.purchase_status,
             s.algorithm_desc, s.algorithm_detail, s.scene_desc, s.basis,
             s.suggest_num, s.suggest_step,
             s.stock_num, s.in_transit, s.day_sale, s.week_sale, s.month_sale,
             s.shortage_day, s.stock_sale_days, s.days_available,
             s.min_order, s.order_multiple, s.purchase_unit, s.relation_ali,
             s.out_price, s.zero_time, s.create_time, s.online_price, s.shelf_name,
             -- ⛔ cost_price / gross_margin_pct 故意不选:那是成本
             -- 起订量/倍数都有时,算出「实际该下多少」(向上取整到倍数)
             CASE WHEN s.min_order IS NULL THEN NULL
                  WHEN s.order_multiple IS NULL OR s.order_multiple <= 1
                       THEN GREATEST(s.suggest_num, s.min_order)
                  ELSE CEIL(GREATEST(s.suggest_num, s.min_order) / s.order_multiple) * s.order_multiple
             END AS orderable_qty,
             -- 这条建议我们这边审过没有(接上补货审核那条线)
             EXISTS (SELECT 1 FROM public.petstore_restock_intents i
                      WHERE i.product_code = s.product_code
                        AND i.status IN ('proposed','approved','executed')) AS in_our_queue
        FROM public.petstore_gdc_suggest s
       WHERE ($1::text IS NULL OR s.store_code = $1)
         AND ($2::text IS NULL OR s.scene = $2)
         AND ($3::text IS NULL OR s.supplier_code = $3)
         AND ($4::text IS NULL OR s.product_name ILIKE '%' || $4 || '%'
              OR s.product_code = $4 OR s.upc_code = $4)
         -- adjust=1 只看智能比价那 11 条(果冻橙那边是另一个页签,同一批次不同商品)
         AND ($7::text IS NULL OR ($7 = '1') = s.is_adjust)
         AND ($8::numeric IS NULL OR s.stock_num >= $8)
         AND ($9::numeric IS NULL OR s.stock_num <= $9)
         AND ($10::numeric IS NULL OR s.min_order >= $10)
         AND ($11::numeric IS NULL OR s.day_sale >= $11)
         AND ($12::numeric IS NULL OR s.stock_sale_days >= $12)
         AND ($13::numeric IS NULL OR s.order_multiple >= $13)
         AND ($14::text IS NULL OR s.purchase_status = $14)
         AND ($15::text IS NULL
              OR ($15 = 'has' AND NULLIF(BTRIM(s.shelf_name), '') IS NOT NULL)
              OR ($15 = 'none' AND NULLIF(BTRIM(s.shelf_name), '') IS NULL))
         AND ($16::text IS NULL
              OR ($16 = 'has' AND s.relation_ali IS TRUE)
              OR ($16 = 'none' AND COALESCE(s.relation_ali, false) = false))
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
    clean(q?.store_code) , clean(q?.scene, 40), clean(q?.supplier_code, 40),
    clean(q?.q, 60), pageSize, (page - 1) * pageSize, clean(q?.adjust, 2),
    num(q?.stock_num_gte), num(q?.stock_num_lte), num(q?.min_order_gte),
    num(q?.day_sale_gte), num(q?.stock_sale_days_gte), num(q?.order_multiple_gte),
    clean(q?.purchase_status, 40), clean(q?.shelf_name, 10), clean(q?.ali_relation, 10),
  ]);
  const f = r.rows[0] || { rows: [], total: 0 };
  return { rows: f.rows, total: f.total, page, pageSize };
}

// 按场景汇总,给顶部条用
async function summary() {
  const r = await getPool().query(
    `SELECT scene, scene_desc, COUNT(*)::int AS cnt,
            COALESCE(SUM(suggest_num),0)::numeric AS suggest_total,
            COUNT(*) FILTER (WHERE stock_num <= 0)::int AS zero_stock,
            COUNT(*) FILTER (WHERE min_order > 1)::int AS has_min_order
       FROM public.petstore_gdc_suggest
      GROUP BY scene, scene_desc ORDER BY 3 DESC`);
  return { rows: r.rows, total: r.rows.length };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (!requireAuth(req, res)) return;
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });
    if (String(req.query?.scope ?? "") === "summary") return json(res, 200, await summary());
    return json(res, 200, await list(req.query || {}));
  } catch (e) { return json(res, 500, { error: e.message || "server_error" }); }
}
