import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 支付流水 + 门店支付汇总 —— 喂「消费记录」「门店支付汇总」「收银订单」几页。
// scope=flow 出微信流水明细,scope=summary 出按月的门店支付汇总。
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
  const scope = cleanText(req.query?.scope, 20) === "summary" ? "summary" : "flow";
  const params = [cleanText(req.query?.store_code, 80), pageSize, offset];
  const sql = scope === "summary" ? `
    WITH filtered AS (
      SELECT store_code, store_name, stat_month, total_amount, real_amount, total_count,
             cash_amount, cash_num, alipay_amount, alipay_num, wechat_amount, wechat_num,
             unionpay_amount, unionpay_num, prepaid_amount, prepaid_num, pulled_at
        FROM public.gdc_payment_summary
       WHERE ($1::text IS NULL OR store_code = $1)
    ), total_count AS (SELECT COUNT(*)::int AS total FROM filtered),
    page_rows AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY stat_month DESC NULLS LAST, store_code ASC) AS __rn
        FROM filtered ORDER BY stat_month DESC NULLS LAST, store_code ASC LIMIT $2 OFFSET $3
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(page_rows) - '__rn' ORDER BY page_rows.__rn)
             FILTER (WHERE page_rows.store_code IS NOT NULL), '[]'::jsonb) AS rows,
           total_count.total FROM total_count LEFT JOIN page_rows ON true GROUP BY total_count.total`
  : `
    WITH filtered AS (
      SELECT id, biz_date, paid_at, kind, store_code, store_name, amount, direction, imported_at
        FROM public.petstore_wechat_payments
       WHERE ($1::text IS NULL OR store_code = $1)
    ), total_count AS (SELECT COUNT(*)::int AS total FROM filtered),
    page_rows AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY paid_at DESC NULLS LAST, id DESC) AS __rn
        FROM filtered ORDER BY paid_at DESC NULLS LAST, id DESC LIMIT $2 OFFSET $3
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(page_rows) - '__rn' ORDER BY page_rows.__rn)
             FILTER (WHERE page_rows.id IS NOT NULL), '[]'::jsonb) AS rows,
           total_count.total FROM total_count LEFT JOIN page_rows ON true GROUP BY total_count.total`;
  const r = await getPool().query(sql, params);
  const f = r.rows[0] || { rows: [], total: 0 };
  return { rows: f.rows, total: f.total, page, pageSize };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (!requireAuth(req, res)) return;
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });
    return json(res, 200, await listRows(req));
  } catch (e) { return json(res, 500, { ok: false, error: e.message || "server_error" }); }
}
