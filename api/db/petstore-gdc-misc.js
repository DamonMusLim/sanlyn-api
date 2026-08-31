import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 两张小表共用一个口：商品分类(89) + 销量监控(8)。
// 各自单开一个文件不值当，但 kind 必须走白名单 —— 🩸 0831 codex 审出过
// `KIND_SQL[kind]` 被 `kind=constructor` 拿到 Object 构造函数塞进 SQL 的洞。
//
// 🔴 销量监控的 cost_price / est_gross_profit / est_gross_profit_rate
//    在库里，但【不出接口】。页面上「进价/预计毛利/利润占比」如实空着。
const KINDS = Object.assign(Object.create(null), {
  category: {
    sql: `SELECT category_code, category_name, parent_code, property, sequence,
                 relation_num, child_count,
                 CASE WHEN parent_code IS NULL THEN '一级' ELSE '二级' END AS level_label,
                 -- 果冻橙那一列写的是「包含子分类/关联商品」，这里拼成一样的形状
                 COALESCE(child_count,0)::text || ' / ' || COALESCE(relation_num,0)::text AS child_relation
            FROM public.petstore_gdc_category
           ORDER BY COALESCE(parent_code, category_code), parent_code NULLS FIRST, sequence`,
    count: "SELECT COUNT(*)::int AS total FROM public.petstore_gdc_category",
  },
  sale_monitor: {
    // ⛔ cost_price / est_gross_profit / est_gross_profit_rate 故意不选
    sql: `SELECT store_code, sku_id, product_name, sku_spec, upc_code,
                 stock_num, price, sale_qty, sale_amount, period_start, period_end
            FROM public.petstore_gdc_sale_monitor
           ORDER BY sale_amount DESC NULLS LAST, sku_id`,
    count: "SELECT COUNT(*)::int AS total FROM public.petstore_gdc_sale_monitor",
  },
});

function json(res, s, d) { return res.status(s).json(d); }

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (!requireAuth(req, res)) return;
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });

    const kind = String(req.query?.kind ?? "").trim();
    // ⛔ 必须 hasOwn，不能只写 KINDS[kind] —— 原型链上的东西会被当成合法 kind
    if (!kind || !Object.hasOwn(KINDS, kind)) {
      return json(res, 400, { ok: false, error: "bad_kind",
        hint: "kind 只能是: " + Object.keys(KINDS).join(" / ") });
    }
    const cfg = KINDS[kind];
    const page = Math.max(1, Number(req.query?.page) || 1);
    const pageSize = Math.min(300, Math.max(1, Number(req.query?.pageSize) || 20));

    const [rows, cnt] = await Promise.all([
      getPool().query(cfg.sql + " LIMIT $1 OFFSET $2", [pageSize, (page - 1) * pageSize]),
      getPool().query(cfg.count),
    ]);
    return json(res, 200, {
      rows: rows.rows, total: (cnt.rows[0] || {}).total || 0, page, pageSize,
    });
  } catch (e) { return json(res, 500, { error: e.message || "server_error" }); }
}
