import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 仓库商品 —— 从果冻橙拉来的 1309 条（仓库 storeCode=63350004，不是金枋 63350001）。
//
// 🔴 purchase_price / supply_price / wholesale_price / supply_gross_profit /
//    wholesale_gross_profit 在库里，但【一律不出接口】—— 采购价/供货价/批发价和毛利都是成本。
//    页面上那几列如实空着。
//
// 实测:1309 条里只有 147 个有库存、16 个设了库存上下限、38 家供应商。
function json(res, s, d) { return res.status(s).json(d); }
function clean(v, m = 80) { const s = String(v ?? "").trim(); return s ? s.slice(0, m) : null; }

const ORDER = Object.assign(Object.create(null), {
  stock: "stock_num DESC NULLS LAST",
  code: "product_code ASC",
  name: "product_name ASC",
});

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (!requireAuth(req, res)) return;
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });
    const q = req.query || {};

    if (String(q.scope ?? "") === "summary") {
      const s = await getPool().query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE stock_num > 0)::int AS with_stock,
                COUNT(*) FILTER (WHERE alarm_num > 0 OR extreme_num > 0)::int AS has_limit,
                COUNT(*) FILTER (WHERE in_transit > 0)::int AS in_transit_cnt,
                COUNT(DISTINCT supplier_name)::int AS suppliers
           FROM public.petstore_gdc_warehouse_product`);
      return json(res, 200, { rows: s.rows, total: s.rows.length });
    }

    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(300, Math.max(1, Number(q.pageSize) || 20));
    const sortKey = clean(q.sort, 20);
    const orderBy = (sortKey && Object.hasOwn(ORDER, sortKey)) ? ORDER[sortKey] : ORDER.stock;

    const sql = `
      WITH filtered AS (
        SELECT w.store_code, w.product_code, w.spu_code, w.product_name, w.spec,
               w.upc_code, w.category_name, w.stock_num, w.in_transit,
               w.alarm_num, w.extreme_num, w.house_min_order, w.store_num,
               w.shelf_name, w.supplier_name, w.purchase_name, w.relation_ali,
               -- ⛔ purchase_price / supply_price / wholesale_price / *_gross_profit 故意不选
               -- 编码/条码拼一起,跟果冻橙那一列对得上
               w.product_code || ' / ' || COALESCE(w.upc_code, '-') AS code_upc,
               -- 库存上下限都没设 = 这个品的补货规则是空的,标出来
               (COALESCE(w.alarm_num, 0) = 0 AND COALESCE(w.extreme_num, 0) = 0) AS no_limit
          FROM public.petstore_gdc_warehouse_product w
         WHERE ($1::text IS NULL OR w.product_name ILIKE '%' || $1 || '%'
                OR w.product_code = $1 OR w.upc_code = $1)
           AND ($2::text IS NULL OR w.category_name = $2)
           AND ($3::text IS NULL
                OR ($3 = 'has'  AND w.stock_num > 0)
                OR ($3 = 'zero' AND COALESCE(w.stock_num, 0) = 0))
      ), total_count AS (SELECT COUNT(*)::int AS total FROM filtered),
      page_rows AS (
        SELECT *, ROW_NUMBER() OVER (ORDER BY ${orderBy}, product_code) AS __rn
          FROM filtered ORDER BY ${orderBy}, product_code
         LIMIT $4 OFFSET $5
      )
      SELECT COALESCE(jsonb_agg(to_jsonb(page_rows) - '__rn' ORDER BY page_rows.__rn)
               FILTER (WHERE page_rows.product_code IS NOT NULL), '[]'::jsonb) AS rows,
             total_count.total FROM total_count LEFT JOIN page_rows ON true GROUP BY total_count.total`;

    const r = await getPool().query(sql, [
      clean(q.q, 60), clean(q.category, 60), clean(q.stock, 10),
      pageSize, (page - 1) * pageSize,
    ]);
    const f = r.rows[0] || { rows: [], total: 0 };
    return json(res, 200, { rows: f.rows, total: f.total, page, pageSize });
  } catch (e) { return json(res, 500, { error: e.message || "server_error" }); }
}
