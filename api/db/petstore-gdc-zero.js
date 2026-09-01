import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 无动销商品 —— 从果冻橙拉来的 2782 个 SKU（1170 个商品）。
//
// 🩸 这一页对老板最要紧的不是"有多少个"，是"压了多少钱"：
//    973 个【有库存却卖不动】的 SKU，库存成本合计 ¥93,278。
//
// 🔴 offline_cost_price / stock_cost / gross_profit / gross_profit_rate
//    在库里，但【一律不出接口】—— 成本红线。页面上那几列如实空着。
//
// ⚠️ 主键是 sku_id 不是 product_code：一个商品下有多个 SKU（不同规格），
//    各有各的价格和库存。按 product_code 去重会把 2830 压成 1180（我第一版就这么错的）。
function json(res, s, d) { return res.status(s).json(d); }
function clean(v, m = 80) { const s = String(v ?? "").trim(); return s ? s.slice(0, m) : null; }

const ORDER = Object.assign(Object.create(null), {
  stock: "stock_num DESC NULLS LAST",     // 库存最多的在前 = 压得最狠的
  price: "price DESC NULLS LAST",
  code: "product_code ASC",
});

async function list(q) {
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(300, Math.max(1, Number(q.pageSize) || 20));
  const sortKey = clean(q.sort, 20);
  const orderBy = (sortKey && Object.hasOwn(ORDER, sortKey)) ? ORDER[sortKey] : ORDER.stock;

  const sql = `
    WITH filtered AS (
      SELECT z.store_code, z.sku_id, z.product_code, z.product_name, z.sku_spec,
             z.upc_code, z.channel_codes, z.product_status,
             z.stock_num, z.price, z.offline_price,
             z.primary_cat, z.secondary_cat, z.pic_url
             -- ⛔ offline_cost_price / stock_cost / gross_profit / gross_profit_rate 故意不选
        FROM public.petstore_gdc_zero_sale z
       WHERE ($1::text IS NULL OR z.store_code = $1)
         AND ($2::text IS NULL OR z.product_name ILIKE '%' || $2 || '%'
              OR z.product_code = $2 OR z.upc_code = $2 OR z.sku_id = $2)
         AND ($3::text IS NULL
              OR ($3 = 'has'  AND z.stock_num > 0)
              OR ($3 = 'zero' AND COALESCE(z.stock_num, 0) = 0))
    ), total_count AS (SELECT COUNT(*)::int AS total FROM filtered),
    page_rows AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY ${orderBy}, sku_id) AS __rn
        FROM filtered ORDER BY ${orderBy}, sku_id
       LIMIT $4 OFFSET $5
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(page_rows) - '__rn' ORDER BY page_rows.__rn)
             FILTER (WHERE page_rows.sku_id IS NOT NULL), '[]'::jsonb) AS rows,
           total_count.total FROM total_count LEFT JOIN page_rows ON true GROUP BY total_count.total`;

  const r = await getPool().query(sql, [
    clean(q.store_code), clean(q.q, 60), clean(q.stock, 10),
    pageSize, (page - 1) * pageSize,
  ]);
  const f = r.rows[0] || { rows: [], total: 0 };
  return { rows: f.rows, total: f.total, page, pageSize };
}

// 汇总：这一页真正要回答的是「压了多少钱」
// ⚠️ 这里【会用到成本】算金额，但只返回汇总数，不返回任何单品成本。
// 🩸 窗口(window_start/end)从【表里】读，不写死在代码里 ——
//    那是"这批数据是哪个窗口拉的"，是数据的属性。写死的话下次换窗口重拉就开始骗人。
// ⚠️ summary 必须吃跟列表【同一套筛选参数】，否则筛完之后底部数字还是全量的，
//    看着像"筛选没生效"或者"数字算错了"。
async function summary(q = {}) {
  const r = await getPool().query(
    `WITH filtered AS (
       SELECT z.product_code, z.stock_num, z.stock_cost, z.price, z.offline_cost_price,
              z.window_start, z.window_end
         FROM public.petstore_gdc_zero_sale z
        WHERE ($1::text IS NULL OR z.store_code = $1)
          AND ($2::text IS NULL OR z.product_name ILIKE '%' || $2 || '%'
               OR z.product_code = $2 OR z.upc_code = $2 OR z.sku_id = $2)
          AND ($3::text IS NULL
               OR ($3 = 'has'  AND z.stock_num > 0)
               OR ($3 = 'zero' AND COALESCE(z.stock_num, 0) = 0))
     )
     SELECT COUNT(*)::int AS sku_total,
            COUNT(DISTINCT product_code)::int AS product_total,
            ROUND(COALESCE(SUM(stock_num), 0)::numeric, 0) AS stock_total,
            COUNT(*) FILTER (WHERE stock_num > 0)::int AS with_stock,
            ROUND(COALESCE(SUM(stock_cost), 0)::numeric, 1) AS stock_cost_total,
            ROUND(COALESCE(SUM(stock_cost) FILTER (WHERE stock_num > 0), 0)::numeric, 1) AS money_stuck,
            COUNT(*) FILTER (WHERE stock_num > 0 AND price IS NOT NULL
                             AND offline_cost_price IS NOT NULL
                             AND price < offline_cost_price)::int AS below_cost,
            MIN(window_start)::text AS window_start,
            MAX(window_end)::text   AS window_end
       FROM filtered`,
    [clean(q.store_code), clean(q.q, 60), clean(q.stock, 10)]);
  const s = r.rows[0] || {};
  return {
    rows: [{ ...s,
      hint: "库存成本总额 = 这批数据里所有 SKU 的库存成本合计",
      stuck_hint: "压着的钱 = 其中【有库存却卖不动】的那部分",
      below_cost_hint: "售价低于成本的，卖一个亏一个" }],
    total: 1,
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (!requireAuth(req, res)) return;
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });
    if (String(req.query?.scope ?? "") === "summary") return json(res, 200, await summary(req.query || {}));
    return json(res, 200, await list(req.query || {}));
  } catch (e) { return json(res, 500, { error: e.message || "server_error" }); }
}
