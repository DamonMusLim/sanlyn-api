import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 库存出入库/调拨/报损 —— 一个接口按 kind 分流,喂 入库/出库/调拨/报损/报盈 几页。
// ⛔ petstore_stock_ledger 里没有成本列,天然安全;但仍不 SELECT *,逐列列出。
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

// 单据类型实测分布:XS销售4640 ML门店4 78 DI调入180 TK退库141 BS报损63 DB调拨25 DO调出24
const KIND_SQL = {
  in:       "delta > 0",                                  // 入库:所有增加
  out:      "delta < 0 AND order_type <> 'XS'",            // 出库:减少但排除销售出货
  sale:     "order_type = 'XS'",                           // 销售出库
  transfer: "order_type IN ('DB','DI','DO')",              // 调拨
  loss:     "order_type = 'BS'",                           // 报损
  back:     "order_type = 'TK'",                           // 退库
};

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
  const kindClause = (kindKey && KIND_SQL[kindKey]) ? `AND (${KIND_SQL[kindKey]})` : "";

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
      SELECT * FROM filtered
       ORDER BY change_time DESC NULLS LAST, order_no DESC
       LIMIT $4 OFFSET $5
    )
    SELECT COALESCE(
             jsonb_agg(to_jsonb(page_rows)) FILTER (WHERE page_rows.product_code IS NOT NULL),
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
