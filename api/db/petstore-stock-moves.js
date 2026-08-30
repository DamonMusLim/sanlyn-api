import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 库存出入库/调拨/报损 —— 一个接口按 kind 分流,喂 入库/出库/调拨/报损/报盈 几页。
// ⛔ petstore_stock_ledger 里没有成本列,天然安全;但仍不 SELECT *,逐列列出。
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

// 单据类型实测分布:XS销售4640 ML门店4 78 DI调入180 TK退库141 BS报损63 DB调拨25 DO调出24
// Object.create(null) + Object.hasOwn 双保险:
// 0830 codex 实测 kind=constructor 会命中继承属性,把函数体拼进 SQL。
const KIND_SQL = Object.assign(Object.create(null), {
  // 口径按【单据类型】划,不按 delta 正负 —— 0830 codex 指出按正负分会互相重叠,
  // 而且 order_type 为 NULL 时 <>'XS' 不成立会被静默排除。
  in:       "order_type IN ('DI','TK')",                 // 入库:调入 + 退库
  out:      "order_type IN ('DO','BS')",                 // 出库:调出 + 报损
  sale:     "order_type = 'XS'",                         // 销售出货
  transfer: "order_type IN ('DB','DI','DO')",            // 调拨(含调入调出)
  loss:     "order_type = 'BS'",                         // 报损
  back:     "order_type = 'TK'",                         // 退库
  store:    "order_type = 'ML'",                         // 门店单
  plus:     "delta > 0",                                 // 纯按数量增加(口径宽,慎用)
  minus:    "delta < 0",                                 // 纯按数量减少
});

function cleanText(value, max = 120) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}
function positiveInt(value, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function paging(query) {
  const page = positiveInt(query?.page, DEFAULT_PAGE);
  const pageSize = Math.min(positiveInt(query?.pageSize, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  return { page, pageSize, offset: (page - 1) * pageSize };
}
function json(res, status, data) { return res.status(status).json(data); }

async function listRows(req) {
  const { page, pageSize, offset } = paging(req.query || {});
  const storeCode = cleanText(req.query?.store_code, 80);
  const productCode = cleanText(req.query?.product_code, 120);
  const orderNo = cleanText(req.query?.order_no, 120);
  // kind 只能是白名单里的键,拼进 SQL 的是【我们自己写死的常量】,不是用户输入
  const kindKey = cleanText(req.query?.kind, 20);
  const kindClause = (kindKey && Object.hasOwn(KIND_SQL, kindKey)) ? `AND (${KIND_SQL[kindKey]})` : "";

  const params = [storeCode, productCode, orderNo, pageSize, offset];
  const sql = `
    WITH filtered AS (
      SELECT store_code, product_code, upc_code, product_name, category_name,
             first_category_name, second_category_name, spec,
             order_type, order_channel, order_no,
             stock_before, stock_after, delta, change_time, remark
        FROM public.petstore_stock_ledger
       WHERE ($1::text IS NULL OR store_code = $1)
         AND ($2::text IS NULL OR product_code = $2)
         AND ($3::text IS NULL OR order_no ILIKE '%' || $3 || '%')
         ${kindClause}
    ), total_count AS (
      SELECT COUNT(*)::int AS total FROM filtered
    ), page_rows AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY change_time DESC NULLS LAST, order_no DESC) AS __rn FROM filtered
       ORDER BY change_time DESC NULLS LAST, order_no DESC
       LIMIT $4 OFFSET $5
    )
    SELECT COALESCE(
             jsonb_agg(to_jsonb(page_rows) - '__rn' ORDER BY page_rows.__rn) FILTER (WHERE page_rows.product_code IS NOT NULL),
             '[]'::jsonb
           ) AS rows,
           total_count.total
      FROM total_count
      LEFT JOIN page_rows ON true
     GROUP BY total_count.total`;

  const result = await getPool().query(sql, params);
  const first = result.rows[0] || { rows: [], total: 0 };
  return { rows: first.rows, total: first.total, page, pageSize };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (!requireAuth(req, res)) return;
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });
    return json(res, 200, await listRows(req));
  } catch (err) {
    return json(res, 500, { ok: false, error: err.message || "server_error" });
  }
}
